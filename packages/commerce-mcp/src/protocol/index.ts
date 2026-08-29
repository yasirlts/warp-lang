/**
 * The protocol integrity bridge — protocol-shaped commerce action in, Warp's
 * structural-integrity verdict out, via the unmodified published guard.
 *
 * Warp sits BENEATH the agentic-commerce protocols and is complementary to them:
 * they discover, check out, and authorize; Warp answers the separate question of
 * whether the commerce move is internally coherent. See
 * `docs/protocol-integrity.md` for the layer map and the honest scope.
 *
 * Nothing in this module claims that any protocol, or its maintainers, has
 * adopted, integrated, endorsed, or reviewed Warp. The adapters describe an
 * integration capability on Warp's side only.
 */
export {
  PROTOCOL_IDS,
  ProtocolIdSchema,
  AcpActionSchema,
  UcpActionSchema,
  Ap2ActionSchema,
} from "./shapes.js";
export type { ProtocolId, AcpAction, UcpAction, Ap2Action, ProtocolAction } from "./shapes.js";

export { fromAcpAction, fromUcpAction, fromAp2Action, mapProtocolAction, moneyFromMinor } from "./adapters.js";
export type { MappingNote, MappingResult, MappingSuccess, MappingGap } from "./adapters.js";

export { guardProtocolAction, taggedAction, SCOPE_NOTE } from "./bridge.js";
export type { ProtocolGuardResult } from "./bridge.js";
