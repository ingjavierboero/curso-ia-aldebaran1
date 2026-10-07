import { X509Certificate, createPrivateKey, webcrypto } from 'node:crypto';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { ArcaError } from './errors.js';

type EngineCrypto = ConstructorParameters<typeof pkijs.CryptoEngine>[0]['crypto'];
pkijs.setEngine('node', new pkijs.CryptoEngine({ name: 'node', crypto: webcrypto as unknown as EngineCrypto }));

const OID_DATA = '1.2.840.113549.1.7.1';
const OID_SIGNED_DATA = '1.2.840.113549.1.7.2';

const toArrayBuffer = (buffer: Buffer): ArrayBuffer =>
  buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;

/**
 * Firma el pedido de acceso (TRA) como CMS SignedData con el contenido incluido, en base64,
 * como lo pide WSAA. Acepta la clave en PKCS#1 ("RSA PRIVATE KEY", la que genera
 * `openssl genrsa`) o en PKCS#8.
 */
export async function signCms(content: string, certificatePem: string, privateKeyPem: string): Promise<string> {
  let certificate: pkijs.Certificate;
  let privateKey: webcrypto.CryptoKey;
  try {
    const certDer = new X509Certificate(certificatePem).raw;
    certificate = pkijs.Certificate.fromBER(toArrayBuffer(certDer));

    const keyDer = createPrivateKey(privateKeyPem).export({ type: 'pkcs8', format: 'der' });
    privateKey = await webcrypto.subtle.importKey(
      'pkcs8',
      toArrayBuffer(keyDer),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    );
  } catch (error) {
    throw new ArcaError(`no se pudo leer el certificado o la clave de ARCA: ${(error as Error).message}`, undefined, {
      cause: error,
    });
  }

  const signedData = new pkijs.SignedData({
    version: 1,
    encapContentInfo: new pkijs.EncapsulatedContentInfo({
      eContentType: OID_DATA,
      eContent: new asn1js.OctetString({ valueHex: new TextEncoder().encode(content) }),
    }),
    signerInfos: [
      new pkijs.SignerInfo({
        version: 1,
        sid: new pkijs.IssuerAndSerialNumber({
          issuer: certificate.issuer,
          serialNumber: certificate.serialNumber,
        }),
      }),
    ],
    certificates: [certificate],
  });
  await signedData.sign(privateKey as unknown as Parameters<typeof signedData.sign>[0], 0, 'SHA-256');

  const contentInfo = new pkijs.ContentInfo({ contentType: OID_SIGNED_DATA, content: signedData.toSchema(true) });
  return Buffer.from(contentInfo.toSchema().toBER(false)).toString('base64');
}
