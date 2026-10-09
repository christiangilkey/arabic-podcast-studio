"""Create the Android release signing key (run once, then keep the output safe forever).

Writes a PKCS#12 keystore and its password to a private folder outside the project,
and prints the base64 text and SHA-1 fingerprint needed for GitHub secrets and Google.
"""

import base64
import datetime
import os
import secrets
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.serialization import pkcs12
from cryptography.x509.oid import NameOID

OUT = Path(os.environ["APPDATA"]) / "ArabicPodcastStudio-signing"
KEYSTORE = OUT / "release.p12"
PASSWORD = OUT / "password.txt"
ALIAS = "release"


def main() -> None:
    if KEYSTORE.exists():
        raise SystemExit(f"A keystore already exists at {KEYSTORE}; refusing to overwrite it.")
    OUT.mkdir(parents=True, exist_ok=True)

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Arabic Podcast Studio")])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)  # self-signed, as Android expects
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now)
        .not_valid_after(now + datetime.timedelta(days=365 * 40))
        .sign(key, hashes.SHA256())
    )
    password = secrets.token_urlsafe(24)
    data = pkcs12.serialize_key_and_certificates(
        ALIAS.encode(), key, cert, None, serialization.BestAvailableEncryption(password.encode())
    )
    KEYSTORE.write_bytes(data)
    PASSWORD.write_text(password)
    (OUT / "release.p12.base64.txt").write_text(base64.b64encode(data).decode())

    sha1 = cert.fingerprint(hashes.SHA1()).hex(":").upper()
    sha256 = cert.fingerprint(hashes.SHA256()).hex(":").upper()
    (OUT / "fingerprints.txt").write_text(f"SHA-1:   {sha1}\nSHA-256: {sha256}\n")
    print(f"Keystore written to {OUT}")
    print(f"SHA-1 fingerprint: {sha1}")


if __name__ == "__main__":
    main()
