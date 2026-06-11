//! Warp DSL lexer (v0.1 per ADR-0007).
//!
//! Tokenizes a `&str` into a `Vec<Token>`. Pure function, no state
//! beyond the input cursor. Errors carry a 1-based line number so
//! diagnostics can name exactly where the source went wrong (P-2:
//! "The compiler is the user's ally"). The parser consumes this
//! token stream; semantic checks (is this node type real? does this
//! reference resolve?) belong to the type checker layer, not here.
//!
//! ## Classification rules
//!
//! - **PascalCase identifier** → `NodeType`. The lexer does not
//!   verify the name exists in any registry; that's the type
//!   checker's job. We only branch by shape.
//! - **snake_case / lower_camel identifier** → `Keyword(project | version | tenant)`
//!   or `Identifier`. Keywords are a closed set; everything else
//!   ending in `Identifier` is a user-chosen name.
//! - **`<identifier>.<field>`** → `Reference`. Recognized eagerly so
//!   the parser doesn't have to glue tokens.
//! - **`Currency(<digits>, <UPPERCASE>)`** and
//!   **`Duration(<digits>, <unit>)`** → first-class
//!   `Currency { amount, code }` / `Duration { amount, unit }`
//!   tokens. ADR-0007 Decision 3: commerce types are syntax, not
//!   stdlib calls.

use std::fmt;

/// One token recognized by the v0.1 lexer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Token {
    Keyword(Keyword),
    NodeType(String),
    Identifier(String),
    StringLit(String),
    Currency { amount: u64, code: String },
    Duration { amount: u64, unit: String },
    Reference { instance: String, field: String },
    LBrace,
    RBrace,
    Colon,
    Comma,
    Equals,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Keyword {
    Project,
    Version,
    Tenant,
}

impl Keyword {
    fn from_str(s: &str) -> Option<Keyword> {
        match s {
            "project" => Some(Keyword::Project),
            "version" => Some(Keyword::Version),
            "tenant" => Some(Keyword::Tenant),
            _ => None,
        }
    }
}

/// Token annotated with its source line so the parser can surface
/// `line: NN` in every error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Spanned {
    pub token: Token,
    pub line: usize,
}

/// Lexer error. The display impl is the human-facing diagnostic.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LexError {
    pub line: usize,
    pub kind: LexErrorKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LexErrorKind {
    UnexpectedChar(char),
    UnterminatedString,
    InvalidEscape(char),
    InvalidNumber(String),
    MalformedCurrency(&'static str),
    MalformedDuration(&'static str),
}

impl fmt::Display for LexError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "lex error at line {}: ", self.line)?;
        match &self.kind {
            LexErrorKind::UnexpectedChar(c) => write!(f, "unexpected character {:?}", c),
            LexErrorKind::UnterminatedString => write!(f, "unterminated string literal"),
            LexErrorKind::InvalidEscape(c) => {
                write!(f, "invalid escape \\{} (expected \\\\ or \\\")", c)
            }
            LexErrorKind::InvalidNumber(s) => write!(f, "invalid numeric literal {:?}", s),
            LexErrorKind::MalformedCurrency(why) => write!(f, "malformed Currency(…): {}", why),
            LexErrorKind::MalformedDuration(why) => write!(f, "malformed Duration(…): {}", why),
        }
    }
}

impl std::error::Error for LexError {}

/// Tokenize `source` into a stream of [`Spanned`] tokens.
///
/// Stops at the first lex error. The parser will refuse to start
/// on an Err, so there's no need to recover and lex onward.
pub fn lex(source: &str) -> Result<Vec<Spanned>, LexError> {
    let mut cursor = Cursor::new(source);
    let mut out: Vec<Spanned> = Vec::new();

    while !cursor.is_eof() {
        cursor.skip_whitespace_and_comments();
        if cursor.is_eof() {
            break;
        }

        let line = cursor.line;
        let c = cursor.peek().unwrap();

        let token = match c {
            '{' => {
                cursor.advance();
                Token::LBrace
            }
            '}' => {
                cursor.advance();
                Token::RBrace
            }
            ':' => {
                cursor.advance();
                Token::Colon
            }
            ',' => {
                cursor.advance();
                Token::Comma
            }
            '=' => {
                cursor.advance();
                Token::Equals
            }
            '"' => lex_string(&mut cursor)?,
            c if c.is_ascii_alphabetic() || c == '_' => lex_word(&mut cursor)?,
            c => {
                return Err(LexError {
                    line,
                    kind: LexErrorKind::UnexpectedChar(c),
                });
            }
        };

        out.push(Spanned { token, line });
    }

    Ok(out)
}

// ---------------------------------------------------------------------------
// Cursor — light wrapper over (input, position, line). Char-based so source
// positions match what the human sees, not byte offsets.
// ---------------------------------------------------------------------------

struct Cursor<'src> {
    chars: Vec<char>,
    pos: usize,
    line: usize,
    _src: std::marker::PhantomData<&'src ()>,
}

impl<'src> Cursor<'src> {
    fn new(source: &'src str) -> Self {
        Cursor {
            chars: source.chars().collect(),
            pos: 0,
            line: 1,
            _src: std::marker::PhantomData,
        }
    }

    fn is_eof(&self) -> bool {
        self.pos >= self.chars.len()
    }

    fn peek(&self) -> Option<char> {
        self.chars.get(self.pos).copied()
    }

    fn peek_at(&self, offset: usize) -> Option<char> {
        self.chars.get(self.pos + offset).copied()
    }

    fn advance(&mut self) -> Option<char> {
        let c = self.peek()?;
        self.pos += 1;
        if c == '\n' {
            self.line += 1;
        }
        Some(c)
    }

    fn skip_whitespace_and_comments(&mut self) {
        loop {
            match self.peek() {
                Some(c) if c.is_whitespace() => {
                    self.advance();
                }
                Some('/') if self.peek_at(1) == Some('/') => {
                    // Line comment — consume to end-of-line.
                    while let Some(c) = self.peek() {
                        if c == '\n' {
                            break;
                        }
                        self.advance();
                    }
                }
                _ => break,
            }
        }
    }
}

// ---------------------------------------------------------------------------
// String literals
// ---------------------------------------------------------------------------

fn lex_string(cursor: &mut Cursor<'_>) -> Result<Token, LexError> {
    let start_line = cursor.line;
    cursor.advance(); // opening "
    let mut out = String::new();
    loop {
        match cursor.advance() {
            None => {
                return Err(LexError {
                    line: start_line,
                    kind: LexErrorKind::UnterminatedString,
                });
            }
            Some('"') => return Ok(Token::StringLit(out)),
            Some('\\') => match cursor.advance() {
                Some('"') => out.push('"'),
                Some('\\') => out.push('\\'),
                Some(c) => {
                    return Err(LexError {
                        line: cursor.line,
                        kind: LexErrorKind::InvalidEscape(c),
                    });
                }
                None => {
                    return Err(LexError {
                        line: start_line,
                        kind: LexErrorKind::UnterminatedString,
                    });
                }
            },
            Some(c) => out.push(c),
        }
    }
}

// ---------------------------------------------------------------------------
// Word tokens — keywords, identifiers, node types, references, currency,
// duration. Disambiguated after the run of letters is consumed.
// ---------------------------------------------------------------------------

fn lex_word(cursor: &mut Cursor<'_>) -> Result<Token, LexError> {
    let line = cursor.line;
    let word = take_identifier(cursor);

    // `Currency(...)` and `Duration(...)` are first-class lexical forms.
    if word == "Currency" && cursor.peek() == Some('(') {
        return lex_currency_tail(cursor, line);
    }
    if word == "Duration" && cursor.peek() == Some('(') {
        return lex_duration_tail(cursor, line);
    }

    // `<ident>.<field>` is one token, eagerly recognized.
    if cursor.peek() == Some('.') {
        // Look ahead one more char — must be an identifier start, not
        // something else (we don't have other use of `.` in v0.1).
        cursor.advance(); // consume .
        let field = take_identifier(cursor);
        if field.is_empty() {
            return Err(LexError {
                line: cursor.line,
                kind: LexErrorKind::UnexpectedChar('.'),
            });
        }
        return Ok(Token::Reference {
            instance: word,
            field,
        });
    }

    // Keyword?
    if let Some(kw) = Keyword::from_str(&word) {
        return Ok(Token::Keyword(kw));
    }

    // PascalCase → node type. Lowercase / snake_case → identifier.
    if word
        .chars()
        .next()
        .map(|c| c.is_ascii_uppercase())
        .unwrap_or(false)
    {
        Ok(Token::NodeType(word))
    } else {
        Ok(Token::Identifier(word))
    }
}

fn take_identifier(cursor: &mut Cursor<'_>) -> String {
    let mut out = String::new();
    while let Some(c) = cursor.peek() {
        if c.is_ascii_alphanumeric() || c == '_' {
            out.push(c);
            cursor.advance();
        } else {
            break;
        }
    }
    out
}

fn lex_currency_tail(cursor: &mut Cursor<'_>, line: usize) -> Result<Token, LexError> {
    expect_char(
        cursor,
        '(',
        line,
        LexErrorKind::MalformedCurrency("expected `(`"),
    )?;
    skip_inline_whitespace(cursor);
    let amount = take_decimal_u64(cursor, line)?;
    skip_inline_whitespace(cursor);
    expect_char(
        cursor,
        ',',
        line,
        LexErrorKind::MalformedCurrency("expected `,` between amount and currency code"),
    )?;
    skip_inline_whitespace(cursor);
    let code = take_currency_code(cursor, line)?;
    skip_inline_whitespace(cursor);
    expect_char(
        cursor,
        ')',
        line,
        LexErrorKind::MalformedCurrency("expected closing `)`"),
    )?;
    Ok(Token::Currency { amount, code })
}

fn lex_duration_tail(cursor: &mut Cursor<'_>, line: usize) -> Result<Token, LexError> {
    expect_char(
        cursor,
        '(',
        line,
        LexErrorKind::MalformedDuration("expected `(`"),
    )?;
    skip_inline_whitespace(cursor);
    let amount = take_decimal_u64(cursor, line)?;
    skip_inline_whitespace(cursor);
    expect_char(
        cursor,
        ',',
        line,
        LexErrorKind::MalformedDuration("expected `,` between amount and unit"),
    )?;
    skip_inline_whitespace(cursor);
    let unit = take_identifier(cursor);
    if unit.is_empty() {
        return Err(LexError {
            line,
            kind: LexErrorKind::MalformedDuration("expected unit identifier"),
        });
    }
    skip_inline_whitespace(cursor);
    expect_char(
        cursor,
        ')',
        line,
        LexErrorKind::MalformedDuration("expected closing `)`"),
    )?;
    Ok(Token::Duration { amount, unit })
}

fn expect_char(
    cursor: &mut Cursor<'_>,
    expected: char,
    line: usize,
    err: LexErrorKind,
) -> Result<(), LexError> {
    if cursor.peek() == Some(expected) {
        cursor.advance();
        Ok(())
    } else {
        Err(LexError { line, kind: err })
    }
}

fn skip_inline_whitespace(cursor: &mut Cursor<'_>) {
    while let Some(c) = cursor.peek() {
        if c == ' ' || c == '\t' {
            cursor.advance();
        } else {
            break;
        }
    }
}

fn take_decimal_u64(cursor: &mut Cursor<'_>, line: usize) -> Result<u64, LexError> {
    let mut raw = String::new();
    while let Some(c) = cursor.peek() {
        if c.is_ascii_digit() {
            raw.push(c);
            cursor.advance();
        } else {
            break;
        }
    }
    if raw.is_empty() {
        return Err(LexError {
            line,
            kind: LexErrorKind::InvalidNumber("(empty)".to_string()),
        });
    }
    raw.parse::<u64>().map_err(|_| LexError {
        line,
        kind: LexErrorKind::InvalidNumber(raw),
    })
}

/// Currency codes are 3 uppercase letters. The lexer enforces the
/// shape; the type checker maps the string to the typed
/// `CurrencyCode` enum (which limits the set to MAD / EUR / USD
/// today).
fn take_currency_code(cursor: &mut Cursor<'_>, line: usize) -> Result<String, LexError> {
    let mut raw = String::new();
    while let Some(c) = cursor.peek() {
        if c.is_ascii_uppercase() {
            raw.push(c);
            cursor.advance();
        } else {
            break;
        }
    }
    if raw.len() != 3 {
        return Err(LexError {
            line,
            kind: LexErrorKind::MalformedCurrency(
                "currency code must be exactly 3 uppercase letters (e.g. MAD)",
            ),
        });
    }
    Ok(raw)
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn lex_ok(src: &str) -> Vec<Token> {
        lex(src)
            .unwrap_or_else(|e| panic!("lex failed: {}", e))
            .into_iter()
            .map(|s| s.token)
            .collect()
    }

    #[test]
    fn lexer_tokenizes_project_keyword() {
        let tokens = lex_ok("project \"cart_recovery\" { }");
        assert_eq!(
            tokens,
            vec![
                Token::Keyword(Keyword::Project),
                Token::StringLit("cart_recovery".to_string()),
                Token::LBrace,
                Token::RBrace,
            ]
        );
    }

    #[test]
    fn lexer_tokenizes_currency_literal() {
        let tokens = lex_ok("min_value: Currency(200, MAD)");
        assert_eq!(
            tokens,
            vec![
                Token::Identifier("min_value".to_string()),
                Token::Colon,
                Token::Currency {
                    amount: 200,
                    code: "MAD".to_string(),
                },
            ]
        );
    }

    #[test]
    fn lexer_tokenizes_duration_literal() {
        let tokens = lex_ok("after: Duration(30, minutes)");
        assert_eq!(
            tokens,
            vec![
                Token::Identifier("after".to_string()),
                Token::Colon,
                Token::Duration {
                    amount: 30,
                    unit: "minutes".to_string(),
                },
            ]
        );
    }

    #[test]
    fn lexer_tokenizes_reference_expression() {
        let tokens = lex_ok("to: profile.phone");
        assert_eq!(
            tokens,
            vec![
                Token::Identifier("to".to_string()),
                Token::Colon,
                Token::Reference {
                    instance: "profile".to_string(),
                    field: "phone".to_string(),
                },
            ]
        );
    }

    #[test]
    fn lexer_handles_line_comments() {
        // The comment carries the only content on line 2 — the keyword on
        // line 3 should report `line == 3`.
        let src = "// header\n\
                   // intent: cart recovery\n\
                   project \"x\" { }";
        let spanned = lex(src).unwrap();
        assert_eq!(spanned[0].token, Token::Keyword(Keyword::Project));
        assert_eq!(
            spanned[0].line, 3,
            "comment lines must still advance the line counter"
        );
    }

    #[test]
    fn lexer_classifies_pascal_case_as_node_type() {
        let tokens = lex_ok("WhatsAppSend first_touch { }");
        assert_eq!(
            tokens,
            vec![
                Token::NodeType("WhatsAppSend".to_string()),
                Token::Identifier("first_touch".to_string()),
                Token::LBrace,
                Token::RBrace,
            ]
        );
    }

    #[test]
    fn lexer_reports_line_number_on_unterminated_string() {
        // No closing `"` at all — the string starts on line 1 and the
        // lexer reaches EOF still expecting one. The error attribution
        // is to the line the string *opened* on (where the operator
        // forgot the closing quote), not to the EOF line.
        let src = "project \"never_closed_at_all";
        let err = lex(src).unwrap_err();
        assert_eq!(err.line, 1, "expected line 1, got {}", err.line);
        assert!(matches!(err.kind, LexErrorKind::UnterminatedString));
    }

    #[test]
    fn lexer_rejects_bad_currency_code() {
        let err = lex("min: Currency(200, mad)").unwrap_err();
        assert!(matches!(err.kind, LexErrorKind::MalformedCurrency(_)));
    }

    #[test]
    fn lexer_passes_through_escaped_quote_in_string() {
        let tokens = lex_ok(r#"x = "he said \"hi\"""#);
        assert_eq!(
            tokens[2],
            Token::StringLit(r#"he said "hi""#.to_string()),
            "got {:?}",
            tokens
        );
    }
}
