// v2/shared/protocol.js
// Central message/shape definitions shared by main thread and workers.
// Keep this file tiny and dependency-free.

export const WorkerMsg = Object.freeze({
  DIFF_REQ: 'diff:req',
  DIFF_RES: 'diff:res',
  ALIGN_REQ: 'align:req',
  ALIGN_RES: 'align:res',
});

/**
 * Edit operation codes (aligned with DMP-style semantics).
 *  -1 = delete from A
 *   0 = equal
 *  +1 = insert from B
 */
export const EditOp = Object.freeze({
  DELETE: -1,
  EQUAL: 0,
  INSERT: 1,
});

/**
 * @typedef {Object} Token
 * @property {string} word        - literal text for this token (single whitespace or a word/punctuation)
 * @property {number} start       - start time (seconds)
 * @property {number} end         - end time (seconds)
 * @property {number} [probability] - optional per-word probability [0..1]
 */

/**
 * @typedef {Object} ConfirmationRange
 * @property {[number, number]} range   - [startChar, endChar) absolute character indices
 * @property {string} [author_id]
 * @property {string|number} [id]
 */

/**
 * @typedef {Object} VersionMeta
 * @property {string} version       - monotonically increasing (server-chosen)
 * @property {string} base_sha256   - hash(text) at this version
 * @property {string} file_path
 */

/**
 * @typedef {Object} DiffReq
 * @property {string} aText
 * @property {string} bText
 */

/**
 * @typedef {Object} DiffRes
 * @property {{op:number, text:string}[]} ops
 */

/**
 * @typedef {Object} AlignReq
 * @property {import('./protocol.js').Token[]} baselineTokens
 * @property {{op:number, text:string}[]} ops   // from DiffRes
 */

/**
 * @typedef {Object} AlignRes
 * @property {import('./protocol.js').Token[]} newTokens
 */
