use base64::{Engine, engine::general_purpose::STANDARD};
use frame::{CaptureOutput, CaptureRequest, render_bgra};
use serde_json::{Value, json};
use std::{error::Error, io::Cursor};

const BGRA: &[u8] = &[
    30, 20, 10, 255, 60, 50, 40, 255, 90, 80, 70, 255, 120, 110, 100, 255,
];

fn hashes() -> Value {
    // From ComputerScreenshotEncoding and AgentDesktopImage on the pre-rewrite branch.
    serde_json::from_str(include_str!("fixtures/hashes.json")).unwrap()
}

fn request(w: u32, h: u32) -> Value {
    json!({"desktopId":"user","frameId":"capture-1","display":{"id":"display-1","label":"Test",
        "primary":true,"bounds":{"x":0,"y":0,"width":w,"height":h},"scaleFactor":1}})
}

fn render(
    req: &Value,
    w: u32,
    h: u32,
    stride: usize,
    bgra: &[u8],
) -> Result<Value, Box<dyn Error>> {
    let request = serde_json::from_str::<CaptureRequest>(&req.to_string())?;
    let output = render_bgra(w, h, stride, bgra, &request)?;
    let output = serde_json::to_value(output)?;
    let roundtrip: CaptureOutput = serde_json::from_value(output.clone())?;
    assert_eq!(serde_json::to_value(roundtrip)?, output);
    Ok(output)
}

fn decode(screenshot: &Value) -> Vec<u8> {
    let data = STANDARD
        .decode(screenshot["data"].as_str().unwrap())
        .unwrap();
    let w = screenshot["width"].as_u64().unwrap() as i32;
    let h = screenshot["height"].as_u64().unwrap() as i32;
    assert_eq!(screenshot["sizeBytes"], data.len());
    let mut bgra = vec![0; (w * h * 4) as usize];
    if screenshot["mimeType"] == "image/png" {
        let mut reader = png::Decoder::new(Cursor::new(data)).read_info().unwrap();
        let info = reader.next_frame(&mut bgra).unwrap();
        assert_eq!(
            (info.width, info.height, info.color_type),
            (w as u32, h as u32, png::ColorType::Rgba)
        );
        for pixel in bgra.as_chunks_mut::<4>().0 {
            pixel.swap(0, 2);
        }
    } else {
        assert_eq!(screenshot["mimeType"], "image/webp");
        let (mut width, mut height) = (0, 0);
        // The decoder writes into the caller-owned BGRA buffer and verifies its capacity.
        unsafe {
            assert_eq!(
                libwebp_sys::WebPGetInfo(data.as_ptr(), data.len(), &mut width, &mut height),
                1
            );
            assert_eq!((width, height), (w, h));
            let pixels = libwebp_sys::WebPDecodeBGRAInto(
                data.as_ptr(),
                data.len(),
                bgra.as_mut_ptr(),
                bgra.len(),
                w * 4,
            );
            assert_eq!(pixels, bgra.as_mut_ptr());
        }
    }
    bgra
}

#[test]
fn formats_match_oracle_hashes_and_decode_as_bgra() {
    let hashes = hashes();
    for (name, side, encoding, resolved) in [
        (
            "lossless2x2",
            2,
            None,
            json!({"format":"webp","mode":"lossless"}),
        ),
        (
            "png1x1",
            1,
            Some(json!({"format":"png"})),
            json!({"format":"png"}),
        ),
        (
            "nearLossless2x2",
            2,
            Some(json!({"format":"webp","mode":"near-lossless"})),
            json!({"format":"webp","mode":"near-lossless","quality":90}),
        ),
        (
            "lossy2x2",
            2,
            Some(json!({"format":"webp","mode":"lossy"})),
            json!({"format":"webp","mode":"lossy","quality":82}),
        ),
    ] {
        let mut req = request(side, side);
        if let Some(encoding) = encoding {
            req["options"] = json!({"screenshot":{"encoding":encoding}});
        }
        let pixels = &BGRA[..side as usize * side as usize * 4];
        let result = render(&req, side, side, side as usize * 4, pixels).unwrap();
        let screenshot = &result["screenshot"];
        assert_eq!(screenshot["contentHash"], hashes[name], "{name}");
        assert_eq!(screenshot["encoding"], resolved);
        assert_eq!(result.get("pointer"), Some(&Value::Null));
        let decoded = decode(screenshot);
        if name != "lossy2x2" {
            assert_eq!(decoded, pixels);
        }
        req["frameId"] = json!("capture-2");
        req["options"]["screenshot"]["unchangedIfContentHash"] = hashes[name].clone();
        let repeat = render(&req, side, side, side as usize * 4, pixels).unwrap();
        assert_eq!(repeat["frame"]["id"], "capture-2");
        assert_eq!(
            repeat["screenshot"],
            json!({"state":"unchanged","contentHash":hashes[name],"width":side,"height":side})
        );
    }
}

#[test]
fn encoders_preserve_exact_pixels_and_apply_requested_webp_quality() {
    let mut source = Vec::new();
    for y in 0..80 {
        for x in 0..96 {
            source.extend_from_slice(&[
                (x * 2 + y * y) as u8,
                (x * x + y * 3) as u8,
                (x * 3 + y * 5) as u8,
                255,
            ]);
        }
    }
    source[..4].copy_from_slice(&[234, 17, 44, 0]);
    let mut req = request(96, 80);
    for (exact, encoding) in [
        (true, json!({"format":"png"})),
        (true, json!({"format":"webp","mode":"lossless"})),
        (
            false,
            json!({"format":"webp","mode":"near-lossless","quality":25}),
        ),
        (false, json!({"format":"webp","mode":"lossy","quality":65})),
    ] {
        req["options"] = json!({"screenshot":{"encoding":encoding}});
        let result = render(&req, 96, 80, 96 * 4, &source).unwrap();
        let decoded = decode(&result["screenshot"]);
        assert_eq!(result["screenshot"]["encoding"], encoding);
        if exact {
            assert_eq!(decoded, source);
        } else {
            assert_ne!(&decoded[4..], &source[4..]);
        }
    }
}

#[test]
fn native_resolution_is_available_while_defaults_fit_the_logical_display() {
    let mut req = request(1000, 1);
    let source = [0; 3200 * 4];
    let default = render(&req, 3200, 1, source.len(), &source).unwrap();
    assert_eq!(default["frame"]["width"], 1000);
    req["options"] = json!({"screenshot":{"maxWidth":4096}});
    let native = render(&req, 3200, 1, source.len(), &source).unwrap();
    assert_eq!(native["frame"]["width"], 3200);
    req["display"]["bounds"]["width"] = json!(3200);
    req["options"] = json!({});
    let bounded = render(&req, 3200, 1, source.len(), &source).unwrap();
    assert_eq!(bounded["frame"]["width"], 1600);
}

#[test]
fn pointer_is_mapped_drawn_and_hashed_independently_in_each_view() {
    let mut source = vec![0; 25 * 25 * 4];
    for pixel in source.as_chunks_mut::<4>().0 {
        pixel[3] = 255;
    }
    let mut req = request(25, 25);
    req["pointer"] = json!({"x":12.5,"y":12.499});
    req["options"] = json!({"detailScreenshots":[{"id":"corner","region":{"displayId":"display-1","coordinateSpace":"desktop-logical","x":0,"y":0,"width":2,"height":2}}]});
    let result = render(&req, 25, 25, 100, &source).unwrap();
    let shot = &result["screenshot"];
    assert_eq!(shot["contentHash"], hashes()["pointer25"]);
    assert_eq!(
        result["pointer"],
        json!({"frameId":"capture-1","position":req["pointer"],"source":"last-commanded"})
    );
    let pixels = decode(shot);
    let pixel = |x, y| -> &[u8] {
        let i = (y * 25usize + x) * 4usize;
        &pixels[i..i + 4]
    };
    assert_eq!(pixel(13, 12), [48, 48, 255, 255]);
    assert_eq!(pixel(23, 12), [0, 230, 255, 255]);
    assert_eq!(pixel(16, 12), [0, 0, 0, 255]);
    let detail = &result["detailScreenshots"][0];
    assert_eq!(detail.get("pointer"), Some(&Value::Null));
    assert_eq!(decode(&detail["screenshot"]), [0, 0, 0, 255].repeat(4));
    assert_eq!(source[(12 * 25 + 13) * 4], 0);
}

#[test]
fn padded_capture_matches_fractional_crops_and_pixel_center_interpolation() {
    let mut pixels = vec![170; 28 * 4];
    for i in 0..24 {
        let offset = i / 6 * 28 + (i % 6) * 4;
        pixels[offset..offset + 4].copy_from_slice(&[
            (i * 7) as u8,
            (i * i) as u8,
            (13 * i + 19) as u8,
            255,
        ]);
    }
    let display_id = "mon\\A";
    let mut req = json!({
        "desktopId":"desk\t\"雪","frameId":"capture-1",
        "display":{"id":display_id,"primary":true,"label":"Test","scaleFactor":1.25,"bounds":{"x":-5,"y":7,"width":8,"height":5}},
        "sourceFrames":[{"id":"prior","coordinateSpace":"image-pixels","displayId":display_id,"width":3,"height":2,
            "toDesktopLogical":{"offsetX":-5,"offsetY":7,"scaleX":8.0/3.0,"scaleY":2.5}}],
        "options":{"screenshot":{"maxWidth":3,"maxHeight":2,"encoding":{"format":"png"}},"detailScreenshots":[
            {"id":"logical","purpose":"toolbar","region":{"coordinateSpace":"desktop-logical","displayId":display_id,"x":-3,"y":9,"width":3,"height":2},"maxWidth":2},
            {"id":"relative","region":{"frameId":"prior","x":1,"y":0,"width":2,"height":1},"maxWidth":4096,"encoding":{"format":"png"}}
        ]}
    });
    let result = render(&req, 6, 4, 28, &pixels).unwrap();
    let hashes = hashes();
    let details = result["detailScreenshots"].as_array().unwrap();
    for (name, view, w, h, transform) in [
        ("overview", &result, 3, 2, [-5.0, 7.0, 8.0 / 3.0, 2.5]),
        (
            "logicalCrop",
            &details[0],
            2,
            2,
            [-5.0 + 1.0 / 0.75, 8.25, 2.0, 1.875],
        ),
        (
            "frameCrop",
            &details[1],
            4,
            2,
            [-5.0 + 2.0 / 0.75, 7.0, 4.0 / 3.0, 1.25],
        ),
    ] {
        assert_eq!(view["screenshot"]["contentHash"], hashes[name], "{name}");
        let t = &view["frame"]["toDesktopLogical"];
        for (key, expected) in ["offsetX", "offsetY", "scaleX", "scaleY"]
            .iter()
            .zip(transform)
        {
            assert_eq!(t[key].as_f64(), Some(expected), "{name}/{key}");
        }
        assert_eq!(view["frame"]["width"], w);
        assert_eq!(view["frame"]["height"], h);
    }
    assert_eq!(details[0]["purpose"], "toolbar");
    assert_ne!(details[0]["frame"]["id"], details[1]["frame"]["id"]);
    req["frameId"] = json!("capture-2");
    req["options"]["screenshot"] = json!(false);
    req["options"]["detailScreenshots"][0]["unchangedIfContentHash"] =
        hashes["logicalCrop"].clone();
    let repeat = render(&req, 6, 4, 28, &pixels).unwrap();
    for key in ["pointer", "frame", "screenshot"] {
        assert!(repeat.get(key).is_none());
    }
    assert_eq!(
        repeat["detailScreenshots"][0]["screenshot"]["state"],
        "unchanged"
    );
    assert_ne!(
        repeat["detailScreenshots"][0]["frame"]["id"],
        details[0]["frame"]["id"]
    );
    assert_eq!(
        repeat["detailScreenshots"][1]["screenshot"]["state"],
        "image"
    );
}

#[test]
fn parses_prior_frame_numbers_without_moving_a_crop_boundary_one_pixel() {
    let mut req = request(26, 1);
    req["sourceFrames"] = json!([{"id":"prior","displayId":"display-1","coordinateSpace":"image-pixels","width":22,"height":1,
        "toDesktopLogical":{"offsetX":0,"offsetY":0,"scaleX":1.1818181818181819,"scaleY":1}}]);
    req["options"] =
        json!({"screenshot":{"region":{"frameId":"prior","x":0,"y":0,"width":11,"height":1}}});
    let result = render(&req, 26, 1, 104, &[0; 104]).unwrap();
    assert_eq!(result["frame"]["width"], 13);
}

#[test]
fn rejects_invalid_geometry_ids_limits_encodings_and_pixel_storage() {
    let req = request(2, 2);
    for options in [
        json!({"screenshot":true}),
        json!({"screenshot":{"maxWidth":0}}),
        json!({"screenshot":{"maxHeight":4097}}),
        json!({"screenshot":{"encoding":{"format":"webp","mode":"lossless","quality":82}}}),
        json!({"screenshot":{"encoding":{"format":"png","mode":"lossy"}}}),
        json!({"screenshot":{"encoding":{"format":"webp","mode":"lossy","quality":0}}}),
        json!({"screenshot":false,"includeAccessibility":false}),
        json!({"detailScreenshots":[]}),
        json!({"detailScreenshots":[{"id":"same"},{"id":"same"}]}),
        json!({"screenshot":{"region":{"frameId":"missing","x":0,"y":0,"width":1,"height":1}}}),
        json!({"screenshot":{"region":{"displayId":"display-1","coordinateSpace":"desktop-logical","x":0,"y":1,"width":2,"height":2}}}),
        json!({"screenshot":{"region":{"displayId":"other","coordinateSpace":"desktop-logical","x":0,"y":0,"width":1,"height":1}}}),
    ] {
        let mut bad = req.clone();
        bad["options"] = options;
        assert!(render(&bad, 2, 2, 8, BGRA).is_err(), "{bad}");
    }
    for (w, h, stride, bytes) in [
        (2, 2, 8, &BGRA[..15]),
        (2, 2, 7, BGRA),
        (1, 2, usize::MAX, BGRA),
        (16_385, 1, 65_540, BGRA),
        (16_384, 16_384, 65_536, BGRA),
    ] {
        assert!(render(&req, w, h, stride, bytes).is_err());
    }
    let mut prior = req.clone();
    let frame = render(&req, 2, 2, 8, BGRA).unwrap()["frame"].clone();
    prior["sourceFrames"] = json!([frame]);
    prior["frameId"] = json!("next");
    for (x, w) in [(1, 2), (u32::MAX, 1), (0, 0)] {
        prior["options"] = json!({"screenshot":{"region":{"frameId":"capture-1","x":x,"y":0,"width":w,"height":1}}});
        assert!(render(&prior, 2, 2, 8, BGRA).is_err());
    }
    prior["options"]["screenshot"]["region"]["width"] = json!(1);
    prior["sourceFrames"][0]["toDesktopLogical"]["offsetX"] = json!(-1);
    assert!(render(&prior, 2, 2, 8, BGRA).is_err());
    prior["sourceFrames"][0]["toDesktopLogical"]["offsetX"] = json!(0);
    prior["sourceFrames"][0]["displayId"] = json!("other");
    assert!(render(&prior, 2, 2, 8, BGRA).is_err());
    let mut only_accessibility = req;
    only_accessibility["options"] = json!({"screenshot":false});
    assert_eq!(
        render(&only_accessibility, 2, 2, 8, BGRA).unwrap(),
        json!({})
    );
}

#[test]
fn verifies_electron_fingerprints_before_migrating_to_portal_identity() {
    let mut old = request(2, 2);
    old["display"]["id"] = json!("334");
    let old_hash = render(&old, 2, 2, 8, BGRA).unwrap()["screenshot"]["contentHash"].clone();
    old["desktopId"] = json!("enrolled-desktop");
    old["display"]["id"] = json!("connector");
    old["options"] = json!({"screenshot":{"unchangedIfContentHash":old_hash}});
    let mut request: CaptureRequest = serde_json::from_value(old).unwrap();
    request.legacy_display_id = Some("334".into());
    let capture =
        |pixels| serde_json::to_value(render_bgra(2, 2, 8, pixels, &request).unwrap()).unwrap();
    let shot = &capture(BGRA)["screenshot"];
    assert_eq!(shot["matchedLegacyContentHash"], old_hash);
    assert_ne!(shot["contentHash"], old_hash);
    assert!(
        capture(&[0; 16])["screenshot"]
            .get("matchedLegacyContentHash")
            .is_none()
    );
}
