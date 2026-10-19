/**
 * Decode subprocess bytes into text, tolerating non-UTF-8 consoles.
 *
 * On Windows a Python subprocess writes its console output in the active code
 * page (GBK on a Chinese system), not UTF-8. Decoding those bytes as UTF-8
 * turns every Chinese assertion message into replacement characters, which
 * destroys exactly the information this tool exists to surface.
 *
 * Strategy: try UTF-8 strictly. If that fails, fall back to the platform's
 * legacy encoding, then to a lossy UTF-8 decode so the caller still gets text.
 *
 * @param {Buffer|string} input - raw captured bytes.
 * @returns {string} decoded text.
 */
export function decodeOutput(input) {
  if (typeof input === 'string') return input
  if (!Buffer.isBuffer(input)) return String(input ?? '')

  // Strip a UTF-8 BOM if the producer wrote one.
  const bytes = input.length >= 3 && input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf
    ? input.subarray(3)
    : input

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) {
    // Not valid UTF-8. Windows consoles commonly emit the ANSI code page.
    const fallbacks = process.platform === 'win32'
      ? ['gbk', 'windows-1252']
      : ['latin1']
    for (const encoding of fallbacks) {
      try {
        return new TextDecoder(encoding).decode(bytes)
      } catch (inner) {
        /* encoding unsupported in this runtime */
      }
    }
    return new TextDecoder('utf-8').decode(bytes)
  }
}

/**
 * Make a subprocess environment that forces UTF-8 output.
 *
 * Setting this on the child is better than decoding guesses: it makes Python
 * emit UTF-8 regardless of the console code page, so assertion messages survive
 * intact. The decoder above remains as a safety net for output that ignored it.
 *
 * @param {NodeJS.ProcessEnv} [base]
 * @returns {NodeJS.ProcessEnv}
 */
export function utf8Env(base) {
  return {
    ...(base ?? process.env),
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    // Keep colour codes out of the parsed output.
    NO_COLOR: '1',
    FORCE_COLOR: '0',
  }
}
