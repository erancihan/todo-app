//! Minimal standard-alphabet base64.
//!
//! Two callers need it: the op log (binary CRDT updates inside JSON) and the
//! projection (a body's CRDT state inside a TEXT column). Both are hot-ish paths
//! on small payloads, and neither justifies a dependency — this is ~40 lines and
//! has no configuration surface to get wrong.

const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = u32::from(b[0]) << 16 | u32::from(b[1]) << 8 | u32::from(b[2]);
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(ALPHABET[((n >> (18 - 6 * i)) & 0x3F) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

pub fn decode(text: &str) -> Result<Vec<u8>, &'static str> {
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let mut buffer = 0u32;
    let mut bits = 0u32;
    for c in text.bytes().filter(|c| *c != b'=') {
        let Some(v) = ALPHABET.iter().position(|a| *a == c) else {
            return Err("invalid base64");
        };
        buffer = buffer << 6 | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_every_trailing_length() {
        for len in 0..16 {
            let bytes: Vec<u8> = (0..len).map(|i| (i as u8).wrapping_mul(37)).collect();
            assert_eq!(decode(&encode(&bytes)).unwrap(), bytes, "len {len}");
        }
    }

    #[test]
    fn round_trips_the_full_byte_range() {
        let bytes: Vec<u8> = (0u8..=255).cycle().take(1000).collect();
        assert_eq!(decode(&encode(&bytes)).unwrap(), bytes);
    }

    #[test]
    fn matches_known_vectors() {
        // Guards against a homegrown-encoder drift from the standard alphabet.
        assert_eq!(encode(b"Man"), "TWFu");
        assert_eq!(encode(b"Ma"), "TWE=");
        assert_eq!(encode(b"M"), "TQ==");
        assert_eq!(encode(b""), "");
        assert_eq!(decode("TWFu").unwrap(), b"Man");
    }

    #[test]
    fn rejects_invalid_input() {
        assert!(decode("not base64!").is_err());
    }
}
