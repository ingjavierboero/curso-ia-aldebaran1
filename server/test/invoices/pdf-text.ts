/** Caracteres de WinAnsi (Windows-1252) entre 0x80 y 0x9F que difieren de latin1. */
const WIN_ANSI: Record<number, string> = {
  0x80: '€', 0x85: '…', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—',
};

const decodeWinAnsi = (bytes: Buffer) => [...bytes].map((b) => WIN_ANSI[b] ?? String.fromCharCode(b)).join('');

/**
 * Extrae el texto de un PDF generado por pdfkit sin compresión: cada operador TJ trae el texto
 * como cadenas hexadecimales en WinAnsi. Devuelve un renglón por operador.
 */
export function pdfText(pdf: Buffer): string {
  const runs = [...pdf.toString('latin1').matchAll(/\[(.*?)\] TJ/g)].map((m) =>
    [...m[1]!.matchAll(/<([0-9a-f]*)>/g)].map((h) => decodeWinAnsi(Buffer.from(h[1]!, 'hex'))).join(''),
  );
  return runs.join('\n');
}
