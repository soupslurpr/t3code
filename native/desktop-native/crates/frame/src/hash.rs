use crate::model::{Encoding, Frame, WebpMode};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::{self, Write};

const PREFIX: &str = "sha256-bgra8-v2:";

pub(crate) fn valid_hash(value: &str) -> bool {
    value.strip_prefix(PREFIX).is_some_and(|suffix| {
        suffix.len() == 43
            && suffix
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    })
}

pub(crate) fn detail_frame_id(parent: &str, ordinal: usize) -> String {
    let digest = URL_SAFE_NO_PAD.encode(Sha256::digest(parent.as_bytes()));
    format!("detail:{digest}:{ordinal}")
}

struct JsNumbers;

impl serde_json::ser::Formatter for JsNumbers {
    fn write_f64<W: Write + ?Sized>(&mut self, writer: &mut W, value: f64) -> io::Result<()> {
        if value == 0.0 {
            return writer.write_all(b"0");
        }
        if value.is_sign_negative() {
            writer.write_all(b"-")?;
        }
        // serde_json supplies shortest, round-to-even digits. JSON.stringify uses different
        // cutoffs for exponent notation and omits both the integer suffix ".0" and negative zero.
        let shortest = serde_json::to_string(&value.abs())?;
        let (mantissa, exponent) = match shortest.split_once('e') {
            None => (shortest.as_str(), 0),
            Some((m, e)) => (m, e.parse::<i32>().expect("finite float exponent")),
        };
        let digits = mantissa.replace('.', "");
        let significant = digits.trim_start_matches('0');
        let decimal = mantissa.find('.').unwrap_or(mantissa.len()) as i32 + exponent
            - (digits.len() - significant.len()) as i32;
        let significant = significant.trim_end_matches('0');
        let n = significant.len() as i32;
        if !(-5..=21).contains(&decimal) {
            writer.write_all(&significant.as_bytes()[..1])?;
            if n > 1 {
                write!(writer, ".{}", &significant[1..])?;
            }
            return write!(writer, "e{:+}", decimal - 1);
        }
        if decimal <= 0 {
            return write!(
                writer,
                "0.{}{}",
                "0".repeat((-decimal) as usize),
                significant
            );
        }
        if decimal >= n {
            return write!(
                writer,
                "{}{}",
                significant,
                "0".repeat((decimal - n) as usize)
            );
        }
        let (integer, fraction) = significant.split_at(decimal as usize);
        write!(writer, "{integer}.{fraction}")
    }
}

pub(crate) fn content_hash(
    desktop_id: &str,
    display_id: &str,
    frame: &Frame,
    encoding: Encoding,
    pixels: &[u8],
) -> String {
    let (format, mode, quality) = match encoding {
        Encoding::Png {} => ("png", None, None),
        Encoding::Webp(WebpMode::Lossless {}) => ("webp", Some("lossless"), None),
        Encoding::Webp(WebpMode::NearLossless { quality }) => {
            ("webp", Some("near-lossless"), Some(quality))
        }
        Encoding::Webp(WebpMode::Lossy { quality }) => ("webp", Some("lossy"), Some(quality)),
    };
    let t = frame.to_desktop_logical;
    let metadata = (
        desktop_id, display_id, t.offset_x, t.offset_y, t.scale_x, t.scale_y, format, mode, quality,
    );
    let mut json = serde_json::Serializer::with_formatter(Vec::new(), JsNumbers);
    metadata
        .serialize(&mut json)
        .expect("finite metadata serialized into memory");
    let hash = Sha256::new()
        .chain_update(b"t3-computer-bgra8-v2\0")
        .chain_update(json.into_inner())
        .chain_update(frame.width.to_be_bytes())
        .chain_update(frame.height.to_be_bytes())
        .chain_update(pixels)
        .finalize();
    format!("{PREFIX}{}", URL_SAFE_NO_PAD.encode(hash))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{CoordinateSpace, Transform};

    #[test]
    fn js_metadata_matches_the_oracle_at_exponent_and_escaping_boundaries() {
        let frame = Frame {
            id: "ignored".into(),
            display_id: "line\u{2028}slash/\\".into(),
            coordinate_space: CoordinateSpace::ImagePixels,
            width: 2,
            height: 2,
            to_desktop_logical: Transform {
                offset_x: -0.0,
                offset_y: -1e-7,
                scale_x: 1e21,
                scale_y: 1.0000000000000002e-6,
            },
        };
        let bgra = [
            30, 20, 10, 255, 60, 50, 40, 255, 90, 80, 70, 255, 120, 110, 100, 255,
        ];
        let expected: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/hashes.json")).unwrap();
        assert_eq!(
            content_hash(
                "d\t\"雪",
                &frame.display_id,
                &frame,
                Encoding::Png {},
                &bgra
            ),
            expected["ecmaNumbers"]
        );
        let mut serializer = serde_json::Serializer::with_formatter(Vec::new(), JsNumbers);
        [
            -0.0,
            1e-7,
            1e-6,
            1e20,
            1e21,
            1000000000000000128.0,
            f64::from_bits(1),
            f64::MAX,
        ]
        .serialize(&mut serializer)
        .unwrap();
        assert_eq!(
            String::from_utf8(serializer.into_inner()).unwrap(),
            "[0,1e-7,0.000001,100000000000000000000,1e+21,1000000000000000100,5e-324,1.7976931348623157e+308]"
        );
    }
}
