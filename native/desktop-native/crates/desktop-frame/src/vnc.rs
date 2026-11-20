use crate::{Bitmap, Result};
use frame::bgra_len;
use std::io::{self, BufRead, BufReader, Read, Take, Write};

const MAX_WIRE_BYTES: u64 = 258 * 1024 * 1024;
const MAX_MESSAGES: usize = 4096;
const MAX_RECTANGLES: usize = 65_535;
const PIXEL_FORMAT: &[u8] = &[
    0, 0, 0, 0, 32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0,
];
const RAW_ENCODING: &[u8] = &[2, 0, 0, 1, 0, 0, 0, 0];

fn field<const N: usize>(input: &mut impl Read) -> io::Result<[u8; N]> {
    let mut bytes = [0; N];
    input.read_exact(&mut bytes)?;
    Ok(bytes)
}

fn skip(input: &mut impl BufRead, mut n: usize) -> io::Result<()> {
    while n > 0 {
        let consumed = input.fill_buf()?.len().min(n);
        if consumed == 0 {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        input.consume(consumed);
        n -= consumed;
    }
    Ok(())
}

fn be16(bytes: &[u8], offset: usize) -> u16 {
    u16::from_be_bytes([bytes[offset], bytes[offset + 1]])
}

struct Connection<S>(BufReader<Take<S>>);

impl<S: Read + Write> Connection<S> {
    fn send(&mut self, bytes: &[u8]) -> io::Result<()> {
        self.0.get_mut().get_mut().write_all(bytes)
    }

    fn negotiate(&mut self) -> Result<(u16, u16)> {
        let version = field::<12>(&mut self.0)?;
        if !matches!(&version, b"RFB 003.007\n" | b"RFB 003.008\n") {
            return Err("unsupported private VNC version".into());
        }
        self.send(&version)?;
        let count = usize::from(field::<1>(&mut self.0)?[0]);
        let mut types = [0; 255];
        self.0.read_exact(&mut types[..count])?;
        if !types[..count].contains(&1) {
            return Err("private VNC server did not offer security type None".into());
        }
        self.send(&[1])?;
        // RFB 3.7 skips SecurityResult when the selected security type is None (RFC 6143 A.2).
        if &version == b"RFB 003.008\n" && field::<4>(&mut self.0)? != [0; 4] {
            return Err("private VNC server rejected the security negotiation".into());
        }
        self.send(&[1])?;
        let init = field::<24>(&mut self.0)?;
        let (width, height) = (be16(&init, 0), be16(&init, 2));
        bgra_len(width.into(), height.into(), usize::from(width) * 4)?;
        let name_len = u32::from_be_bytes(init[20..24].try_into()?);
        if name_len > 4096 {
            return Err("VNC server name exceeds its limit".into());
        }
        skip(&mut self.0, name_len as usize)?;
        self.send(PIXEL_FORMAT)?;
        self.send(RAW_ENCODING)?;
        Ok((width, height))
    }

    fn request_full(&mut self, width: u16, height: u16) -> io::Result<()> {
        let mut request = [3, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        request[6..8].copy_from_slice(&width.to_be_bytes());
        request[8..10].copy_from_slice(&height.to_be_bytes());
        self.send(&request)
    }
}

struct Assembly {
    bitmap: Bitmap,
    covered: Vec<u64>,
    missing: usize,
}

impl Assembly {
    fn new(width: u16, height: u16) -> Result<Self> {
        let stride = usize::from(width) * 4;
        let bytes = bgra_len(width.into(), height.into(), stride)?;
        let missing = bytes / 4;
        Ok(Self {
            bitmap: Bitmap {
                width: width.into(),
                height: height.into(),
                stride,
                pixels: vec![0; bytes],
            },
            covered: vec![0; missing.div_ceil(64)],
            missing,
        })
    }

    fn read_pixels(&mut self, input: &mut impl Read, start: usize, count: usize) -> io::Result<()> {
        let end = start + count;
        input.read_exact(&mut self.bitmap.pixels[start * 4..end * 4])?;
        let last = (end - 1) / 64;
        for index in start / 64..=last {
            let first_bit = start.saturating_sub(index * 64);
            let last_bit = (end - 1 - index * 64).min(63);
            let mask = (u64::MAX << first_bit) & (u64::MAX >> (63 - last_bit));
            let word = &mut self.covered[index];
            self.missing -= (mask & !*word).count_ones() as usize;
            *word |= mask;
        }
        Ok(())
    }

    fn rectangle(&mut self, input: &mut impl Read) -> Result<()> {
        let header = field::<12>(input)?;
        let x = usize::from(be16(&header, 0));
        let y = usize::from(be16(&header, 2));
        let width = usize::from(be16(&header, 4));
        let height = usize::from(be16(&header, 6));
        let row_width = self.bitmap.width as usize;
        if header[8..] != [0; 4]
            || width == 0
            || height == 0
            || x + width > row_width
            || y + height > self.bitmap.height as usize
        {
            return Err("invalid raw VNC rectangle".into());
        }
        if width == row_width {
            self.read_pixels(input, y * row_width, height * width)?;
        } else {
            for row in y..y + height {
                self.read_pixels(input, row * row_width + x, width)?;
            }
        }
        Ok(())
    }
}

pub(crate) fn capture<S: Read + Write>(socket: S) -> Result<Bitmap> {
    let mut conn = Connection(BufReader::new(socket.take(MAX_WIRE_BYTES)));
    let (width, height) = conn.negotiate()?;
    let mut frame = Assembly::new(width, height)?;
    conn.request_full(width, height)?;
    let mut rectangles = 0;
    for _ in 0..MAX_MESSAGES {
        match field::<1>(&mut conn.0)?[0] {
            0 => {
                let count = usize::from(be16(&field::<3>(&mut conn.0)?, 1));
                rectangles += count;
                if rectangles > MAX_RECTANGLES {
                    return Err("too many VNC rectangles".into());
                }
                for _ in 0..count {
                    frame.rectangle(&mut conn.0)?;
                }
                if frame.missing == 0 {
                    for alpha in frame.bitmap.pixels[3..].iter_mut().step_by(4) {
                        *alpha = 255;
                    }
                    return Ok(frame.bitmap);
                }
                conn.request_full(width, height)?;
            }
            1 => {
                let colors = be16(&field::<5>(&mut conn.0)?, 3);
                skip(&mut conn.0, usize::from(colors) * 6)?;
            }
            2 => {}
            3 => {
                let header = field::<7>(&mut conn.0)?;
                let len = u32::from_be_bytes(header[3..].try_into()?);
                if len > 65_536 {
                    return Err("VNC clipboard message exceeds its limit".into());
                }
                skip(&mut conn.0, len as usize)?;
            }
            _ => return Err("unsupported VNC server message".into()),
        }
    }
    Err("too many messages before a complete VNC frame".into())
}
