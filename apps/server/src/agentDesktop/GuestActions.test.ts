import { expect, it, vi } from "vite-plus/test";
import { typeGuestText } from "./GuestActions.ts";
import type { GuestAccessibility } from "./GuestAccessibility.ts";

it("blocks literal control characters before fallback and never replays an ambiguous insertion", async () => {
  const ibus = vi.fn(async () => 3),
    chord = vi.fn(async () => {}),
    delay = vi.fn(async () => {});
  const insert = vi.fn<GuestAccessibility["insert"]>(async () => ({ status: "unavailable" }));
  const semantics: GuestAccessibility = {
    insert,
    ibus,
    snapshot: async () => {
      throw new Error();
    },
    consume: () => async () => false,
  };
  for (const text of ["a\tb", "a\nb"]) {
    await expect(
      typeGuestText({ type: "type", text, submit: true }, 0, semantics, chord, delay),
    ).rejects.toThrow("editable");
  }
  insert.mockRejectedValueOnce(new Error("reply lost"));
  await expect(
    typeGuestText({ type: "type", text: "雪", submit: true }, 0, semantics, chord, delay),
  ).rejects.toThrow("reply lost");
  expect(ibus).not.toHaveBeenCalled();
  expect(chord).not.toHaveBeenCalled();
  expect(
    await typeGuestText(
      { type: "type", text: "雪\u{1F642}雪", submit: true, verification: "required" },
      0,
      semantics,
      chord,
      delay,
    ),
  ).toMatchObject({
    acceptedCodePoints: 3,
    confirmedCodePoints: 0,
    delivery: "input-method",
    submission: "withheld-unverified",
  });
  expect(chord).not.toHaveBeenCalled();
  insert.mockResolvedValueOnce({
    status: "inserted",
    injectedCodePoints: 3,
    confirmedCodePoints: 3,
  });
  expect(
    await typeGuestText({ type: "type", text: "a\tb", submit: true }, 0, semantics, chord, delay),
  ).toMatchObject({ verification: "exact", submission: "submitted" });
  expect(chord).toHaveBeenCalledExactlyOnceWith(["ret"]);
});
