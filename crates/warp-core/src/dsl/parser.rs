//! Warp DSL parser (v0.1 per ADR-0007).
//!
//! Recursive-descent parser consuming the token stream from
//! [`super::lexer`] and producing a [`super::ast::WarpProject`].
//!
//! Scope: **syntax only.** This layer does not validate node types
//! against any registry, does not type-check field names, does not
//! resolve references. Those checks land in the type-checker (next
//! compiler session). Keeping the parser pure means the same parser
//! works against a richer catalog later — only the type checker has
//! to know what's installed.

use std::fmt;

use super::ast::{ConfigEntry, ConfigValue, NodeDecl, WarpProject};
use super::lexer::{Keyword, Spanned, Token};

/// Parse error. Every error names the token found, the token (or
/// shape) expected, and the 1-based line — ADR-0007 Decision 4.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseError {
    pub line: usize,
    pub kind: ParseErrorKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParseErrorKind {
    /// `expected` is a human-readable shape (e.g. `"RBRACE"`,
    /// `"a NODE_TYPE"`); `found` is the rendered offending token.
    Unexpected { expected: String, found: String },
    /// EOF hit while a node / project was still open. Distinct from
    /// `Unexpected` so the error message can name the construct.
    UnexpectedEof { expected: String },
    /// Two declarations within the same scope used the same key.
    /// Today only `project` headers can repeat their `version` /
    /// `tenant`; node configs allow each key once.
    DuplicateKey { key: String },
    /// The project header was missing `version` or `tenant` — both
    /// are required in v0.1.
    MissingProjectField { field: &'static str },
}

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "parse error at line {}: ", self.line)?;
        match &self.kind {
            ParseErrorKind::Unexpected { expected, found } => {
                write!(f, "expected {}, found {}", expected, found)
            }
            ParseErrorKind::UnexpectedEof { expected } => {
                write!(f, "expected {}, found end of input", expected)
            }
            ParseErrorKind::DuplicateKey { key } => {
                write!(f, "duplicate key {:?} in the same block", key)
            }
            ParseErrorKind::MissingProjectField { field } => {
                write!(f, "project header missing required field `{}`", field)
            }
        }
    }
}

impl std::error::Error for ParseError {}

/// Parse a token stream into a [`WarpProject`].
pub fn parse(tokens: Vec<Spanned>) -> Result<WarpProject, ParseError> {
    let mut p = Parser::new(tokens);
    let project = p.parse_project()?;
    p.expect_eof()?;
    Ok(project)
}

// ---------------------------------------------------------------------------
// Parser state
// ---------------------------------------------------------------------------

struct Parser {
    tokens: Vec<Spanned>,
    pos: usize,
    /// Line number to attribute an EOF error to (the last token's
    /// line, since EOF itself has no line).
    last_line: usize,
}

impl Parser {
    fn new(tokens: Vec<Spanned>) -> Self {
        let last_line = tokens.last().map(|s| s.line).unwrap_or(1);
        Parser {
            tokens,
            pos: 0,
            last_line,
        }
    }

    fn peek(&self) -> Option<&Spanned> {
        self.tokens.get(self.pos)
    }

    fn bump(&mut self) -> Option<Spanned> {
        let s = self.tokens.get(self.pos).cloned()?;
        self.pos += 1;
        Some(s)
    }

    fn current_line(&self) -> usize {
        self.peek().map(|s| s.line).unwrap_or(self.last_line)
    }

    fn expect_eof(&mut self) -> Result<(), ParseError> {
        match self.peek() {
            None => Ok(()),
            Some(spanned) => Err(ParseError {
                line: spanned.line,
                kind: ParseErrorKind::Unexpected {
                    expected: "end of input".to_string(),
                    found: render_token(&spanned.token),
                },
            }),
        }
    }

    // -----------------------------------------------------------------------
    // project = "project" STRING "{" project_header_field* node_decl* "}"
    // -----------------------------------------------------------------------

    fn parse_project(&mut self) -> Result<WarpProject, ParseError> {
        self.expect_keyword(Keyword::Project)?;
        let name = self.expect_string("project name")?;
        self.expect_lbrace("project body")?;

        let mut version: Option<String> = None;
        let mut tenant: Option<String> = None;
        let mut nodes: Vec<NodeDecl> = Vec::new();

        loop {
            match self.peek() {
                None => {
                    return Err(ParseError {
                        line: self.last_line,
                        kind: ParseErrorKind::UnexpectedEof {
                            expected: "`}` to close project body".to_string(),
                        },
                    });
                }
                Some(spanned) if matches!(spanned.token, Token::RBrace) => {
                    self.bump();
                    break;
                }
                Some(spanned) => match &spanned.token {
                    Token::Keyword(Keyword::Version) => {
                        let line = spanned.line;
                        self.bump();
                        self.expect_equals("after `version`")?;
                        let value = self.expect_string("version string")?;
                        if version.is_some() {
                            return Err(ParseError {
                                line,
                                kind: ParseErrorKind::DuplicateKey {
                                    key: "version".to_string(),
                                },
                            });
                        }
                        version = Some(value);
                    }
                    Token::Keyword(Keyword::Tenant) => {
                        let line = spanned.line;
                        self.bump();
                        self.expect_equals("after `tenant`")?;
                        let value = self.expect_string("tenant string")?;
                        if tenant.is_some() {
                            return Err(ParseError {
                                line,
                                kind: ParseErrorKind::DuplicateKey {
                                    key: "tenant".to_string(),
                                },
                            });
                        }
                        tenant = Some(value);
                    }
                    Token::NodeType(_) => {
                        let node = self.parse_node_decl()?;
                        nodes.push(node);
                    }
                    other => {
                        let line = spanned.line;
                        return Err(ParseError {
                            line,
                            kind: ParseErrorKind::Unexpected {
                                expected: "`version`, `tenant`, a NODE_TYPE, or `}`".to_string(),
                                found: render_token(other),
                            },
                        });
                    }
                },
            }
        }

        Ok(WarpProject {
            name,
            version: version.ok_or(ParseError {
                line: self.last_line,
                kind: ParseErrorKind::MissingProjectField { field: "version" },
            })?,
            tenant: tenant.ok_or(ParseError {
                line: self.last_line,
                kind: ParseErrorKind::MissingProjectField { field: "tenant" },
            })?,
            nodes,
        })
    }

    // -----------------------------------------------------------------------
    // node_decl = NODE_TYPE IDENTIFIER "{" config_entry* "}"
    // -----------------------------------------------------------------------

    fn parse_node_decl(&mut self) -> Result<NodeDecl, ParseError> {
        let header = self.bump().expect("caller verified NODE_TYPE present");
        let node_type = match header.token {
            Token::NodeType(name) => name,
            _ => unreachable!("dispatched on NodeType variant"),
        };
        let instance_name = self.expect_identifier("instance name after node type")?;
        self.expect_lbrace("node body")?;
        let entries = self.parse_config_entries("node body")?;
        Ok(NodeDecl {
            node_type,
            instance_name,
            config: entries,
        })
    }

    // -----------------------------------------------------------------------
    // config_entries = (config_entry ("," config_entry)*)? "}"
    // - Trailing comma allowed
    // - Empty body allowed
    // - Commas between entries are optional (newlines are sufficient).
    //   The parser accepts both styles so the canonical example in
    //   ADR-0007 (no commas) and JSON-like styles both parse.
    // -----------------------------------------------------------------------

    fn parse_config_entries(&mut self, _context: &str) -> Result<Vec<ConfigEntry>, ParseError> {
        let mut entries: Vec<ConfigEntry> = Vec::new();
        loop {
            match self.peek() {
                None => {
                    return Err(ParseError {
                        line: self.last_line,
                        kind: ParseErrorKind::UnexpectedEof {
                            expected: "`}` to close block".to_string(),
                        },
                    });
                }
                Some(spanned) if matches!(spanned.token, Token::RBrace) => {
                    self.bump();
                    return Ok(entries);
                }
                Some(spanned) if matches!(spanned.token, Token::Comma) => {
                    self.bump();
                    continue;
                }
                _ => {}
            }
            let entry = self.parse_config_entry()?;
            if entries.iter().any(|e| e.key == entry.key) {
                return Err(ParseError {
                    line: self.current_line(),
                    kind: ParseErrorKind::DuplicateKey {
                        key: entry.key.clone(),
                    },
                });
            }
            entries.push(entry);
        }
    }

    // -----------------------------------------------------------------------
    // config_entry = IDENTIFIER ":" config_value
    // -----------------------------------------------------------------------

    fn parse_config_entry(&mut self) -> Result<ConfigEntry, ParseError> {
        let key = self.expect_identifier("config key")?;
        self.expect_colon("after config key")?;
        let value = self.parse_config_value()?;
        Ok(ConfigEntry { key, value })
    }

    // -----------------------------------------------------------------------
    // config_value = STRING | CURRENCY | DURATION | REFERENCE
    //              | "{" config_entry* "}"
    // -----------------------------------------------------------------------

    fn parse_config_value(&mut self) -> Result<ConfigValue, ParseError> {
        let spanned = self.bump().ok_or(ParseError {
            line: self.last_line,
            kind: ParseErrorKind::UnexpectedEof {
                expected: "a config value (string, Currency, Duration, reference, or `{ … }`)"
                    .to_string(),
            },
        })?;
        match spanned.token {
            Token::StringLit(s) => Ok(ConfigValue::StringLit(s)),
            Token::Currency { amount, code } => Ok(ConfigValue::Currency { amount, code }),
            Token::Duration { amount, unit } => Ok(ConfigValue::Duration { amount, unit }),
            Token::Reference { instance, field } => Ok(ConfigValue::Reference { instance, field }),
            Token::LBrace => {
                let entries = self.parse_config_entries("object value")?;
                Ok(ConfigValue::Object(entries))
            }
            other => Err(ParseError {
                line: spanned.line,
                kind: ParseErrorKind::Unexpected {
                    expected: "a config value (string, Currency, Duration, reference, or `{ … }`)"
                        .to_string(),
                    found: render_token(&other),
                },
            }),
        }
    }

    // -----------------------------------------------------------------------
    // Single-token expectation helpers — each emits the standard
    // "expected X, found Y at line N" diagnostic.
    // -----------------------------------------------------------------------

    fn expect_keyword(&mut self, kw: Keyword) -> Result<(), ParseError> {
        let spanned = self.bump().ok_or(ParseError {
            line: self.last_line,
            kind: ParseErrorKind::UnexpectedEof {
                expected: format!("keyword `{}`", keyword_name(kw)),
            },
        })?;
        match spanned.token {
            Token::Keyword(actual) if actual == kw => Ok(()),
            other => Err(ParseError {
                line: spanned.line,
                kind: ParseErrorKind::Unexpected {
                    expected: format!("keyword `{}`", keyword_name(kw)),
                    found: render_token(&other),
                },
            }),
        }
    }

    fn expect_string(&mut self, context: &str) -> Result<String, ParseError> {
        let spanned = self.bump().ok_or(ParseError {
            line: self.last_line,
            kind: ParseErrorKind::UnexpectedEof {
                expected: format!("STRING ({})", context),
            },
        })?;
        match spanned.token {
            Token::StringLit(s) => Ok(s),
            other => Err(ParseError {
                line: spanned.line,
                kind: ParseErrorKind::Unexpected {
                    expected: format!("STRING ({})", context),
                    found: render_token(&other),
                },
            }),
        }
    }

    fn expect_identifier(&mut self, context: &str) -> Result<String, ParseError> {
        let spanned = self.bump().ok_or(ParseError {
            line: self.last_line,
            kind: ParseErrorKind::UnexpectedEof {
                expected: format!("IDENTIFIER ({})", context),
            },
        })?;
        match spanned.token {
            Token::Identifier(s) => Ok(s),
            other => Err(ParseError {
                line: spanned.line,
                kind: ParseErrorKind::Unexpected {
                    expected: format!("IDENTIFIER ({})", context),
                    found: render_token(&other),
                },
            }),
        }
    }

    fn expect_lbrace(&mut self, context: &str) -> Result<(), ParseError> {
        self.expect_simple(Token::LBrace, format!("`{{` ({})", context))
    }

    fn expect_colon(&mut self, context: &str) -> Result<(), ParseError> {
        self.expect_simple(Token::Colon, format!("`:` ({})", context))
    }

    fn expect_equals(&mut self, context: &str) -> Result<(), ParseError> {
        self.expect_simple(Token::Equals, format!("`=` ({})", context))
    }

    fn expect_simple(&mut self, want: Token, label: String) -> Result<(), ParseError> {
        let spanned = self.bump().ok_or(ParseError {
            line: self.last_line,
            kind: ParseErrorKind::UnexpectedEof {
                expected: label.clone(),
            },
        })?;
        if spanned.token == want {
            Ok(())
        } else {
            Err(ParseError {
                line: spanned.line,
                kind: ParseErrorKind::Unexpected {
                    expected: label,
                    found: render_token(&spanned.token),
                },
            })
        }
    }
}

fn keyword_name(kw: Keyword) -> &'static str {
    match kw {
        Keyword::Project => "project",
        Keyword::Version => "version",
        Keyword::Tenant => "tenant",
    }
}

fn render_token(token: &Token) -> String {
    match token {
        Token::Keyword(kw) => format!("keyword `{}`", keyword_name(*kw)),
        Token::NodeType(name) => format!("NODE_TYPE({:?})", name),
        Token::Identifier(name) => format!("IDENTIFIER({:?})", name),
        Token::StringLit(s) => format!("STRING({:?})", s),
        Token::Currency { amount, code } => format!("CURRENCY({}, {})", amount, code),
        Token::Duration { amount, unit } => format!("DURATION({}, {})", amount, unit),
        Token::Reference { instance, field } => format!("REFERENCE({}.{})", instance, field),
        Token::LBrace => "`{`".to_string(),
        Token::RBrace => "`}`".to_string(),
        Token::Colon => "`:`".to_string(),
        Token::Comma => "`,`".to_string(),
        Token::Equals => "`=`".to_string(),
    }
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsl::lexer::lex;

    fn parse_str(src: &str) -> Result<WarpProject, ParseError> {
        let tokens = lex(src).expect("lex must succeed in parser tests");
        parse(tokens)
    }

    const MINIMAL: &str = r#"
        project "minimal" {
            version = "1.0.0"
            tenant  = "tenant_x"

            CartAbandoned trigger {
                min_value: Currency(200, MAD)
            }
        }
    "#;

    #[test]
    fn parser_parses_minimal_project() {
        let project = parse_str(MINIMAL).unwrap();
        assert_eq!(project.name, "minimal");
        assert_eq!(project.version, "1.0.0");
        assert_eq!(project.tenant, "tenant_x");
        assert_eq!(project.nodes.len(), 1);
        let node = &project.nodes[0];
        assert_eq!(node.node_type, "CartAbandoned");
        assert_eq!(node.instance_name, "trigger");
        assert_eq!(node.config.len(), 1);
        assert_eq!(node.config[0].key, "min_value");
        assert_eq!(
            node.config[0].value,
            ConfigValue::Currency {
                amount: 200,
                code: "MAD".to_string(),
            }
        );
    }

    const FULL_CART_RECOVERY: &str = r#"
        project "cart_recovery" {
            version = "1.0.0"
            tenant  = "tenant_aimer_prod_001"

            CartAbandoned trigger {
                min_value: Currency(200, MAD)
                after:     Duration(30, minutes)
            }

            ACPGetCustomerProfile profile {
                customer_id: trigger.customer_id
            }

            WhatsAppSend first_touch {
                to:       profile.phone
                template: "cart_reminder"
                lang:     profile.language
            }

            DelayFor wait {
                duration: Duration(24, hours)
            }

            ACPEvaluateStrategy offer {
                customer_id: trigger.customer_id
                cart_state:  trigger.cart_state
            }

            WhatsAppSend followup {
                to:       profile.phone
                template: "cart_offer"
                lang:     profile.language
                params:   { discount_code: offer.discount_code }
            }
        }
    "#;

    #[test]
    fn parser_parses_full_cart_recovery() {
        let project = parse_str(FULL_CART_RECOVERY).expect("full example must parse");
        assert_eq!(project.name, "cart_recovery");
        assert_eq!(project.tenant, "tenant_aimer_prod_001");
        assert_eq!(project.nodes.len(), 6);

        let names: Vec<&str> = project
            .nodes
            .iter()
            .map(|n| n.instance_name.as_str())
            .collect();
        assert_eq!(
            names,
            vec![
                "trigger",
                "profile",
                "first_touch",
                "wait",
                "offer",
                "followup"
            ]
        );

        // Spot-check the parts of each node a downstream type checker
        // will rely on.
        let trigger = &project.nodes[0];
        assert_eq!(trigger.node_type, "CartAbandoned");
        let after = trigger
            .config
            .iter()
            .find(|e| e.key == "after")
            .expect("trigger must declare `after`");
        assert_eq!(
            after.value,
            ConfigValue::Duration {
                amount: 30,
                unit: "minutes".to_string(),
            }
        );

        let first_touch = &project.nodes[2];
        let to = first_touch
            .config
            .iter()
            .find(|e| e.key == "to")
            .expect("first_touch must wire `to`");
        assert_eq!(
            to.value,
            ConfigValue::Reference {
                instance: "profile".to_string(),
                field: "phone".to_string(),
            }
        );

        // `params: { discount_code: offer.discount_code }` parses as a
        // nested object with a single reference entry.
        let followup = &project.nodes[5];
        let params = followup
            .config
            .iter()
            .find(|e| e.key == "params")
            .expect("followup must declare `params`");
        match &params.value {
            ConfigValue::Object(entries) => {
                assert_eq!(entries.len(), 1);
                assert_eq!(entries[0].key, "discount_code");
                assert_eq!(
                    entries[0].value,
                    ConfigValue::Reference {
                        instance: "offer".to_string(),
                        field: "discount_code".to_string(),
                    }
                );
            }
            other => panic!("expected Object, got {:?}", other),
        }
    }

    #[test]
    fn parser_error_includes_line_number() {
        // The header is OK; the offending token sits on the line where
        // a node body opens but its key is missing a `:`.
        let src = "\n\
                   project \"x\" {\n\
                       version = \"1.0\"\n\
                       tenant = \"t\"\n\
                       CartAbandoned trigger {\n\
                           min_value Currency(200, MAD)\n\
                       }\n\
                   }\n";
        let err = parse_str(src).unwrap_err();
        // The `Currency(...)` is found where the parser expected `:`.
        assert_eq!(
            err.line, 6,
            "error must point at the line of the malformed entry, got {}: {}",
            err.line, err
        );
        // Diagnostic shape: "expected `:` …, found CURRENCY(200, MAD)"
        assert!(
            matches!(err.kind, ParseErrorKind::Unexpected { .. }),
            "got {:?}",
            err.kind
        );
        let msg = err.to_string();
        assert!(
            msg.contains(':'),
            "diagnostic should name what was expected"
        );
    }

    #[test]
    fn parser_rejects_unclosed_brace() {
        let src = r#"
            project "x" {
                version = "1.0"
                tenant  = "t"

                CartAbandoned trigger {
                    min_value: Currency(200, MAD)
        "#;
        let err = parse_str(src).unwrap_err();
        assert!(
            matches!(err.kind, ParseErrorKind::UnexpectedEof { .. }),
            "got {:?}",
            err.kind
        );
        assert!(err.to_string().contains("`}`"));
    }

    #[test]
    fn parser_rejects_duplicate_config_keys() {
        let src = r#"
            project "x" {
                version = "1.0"
                tenant  = "t"
                WhatsAppSend first_touch {
                    template: "a"
                    template: "b"
                }
            }
        "#;
        let err = parse_str(src).unwrap_err();
        assert!(
            matches!(err.kind, ParseErrorKind::DuplicateKey { ref key } if key == "template"),
            "got {:?}",
            err.kind
        );
    }

    #[test]
    fn parser_rejects_missing_project_version() {
        let src = r#"
            project "x" {
                tenant = "t"
                CartAbandoned trigger { }
            }
        "#;
        let err = parse_str(src).unwrap_err();
        assert!(
            matches!(
                err.kind,
                ParseErrorKind::MissingProjectField { field: "version" }
            ),
            "got {:?}",
            err.kind
        );
    }
}
