# Computer-Use VM Testing

The desktop package includes an opt-in retained-VM regression check and observation-cost benchmark.
They expect an isolated GNOME VM running the current desktop build, with its T3 Code renderer exposed
over a loopback-only Chrome DevTools endpoint and SSH available through a loopback port. They do not
create, configure, or start a VM themselves.

Run `vp run --filter @t3tools/desktop test:computer-use-vm` to exercise remembered control, scaled
pointer input, real wheel ticks, exact Unicode typing without clipboard mutation, native editable and
window semantic targets, rejection of unsafe multiline fallback before any keyboard input, keyboard
selection targets, early accessibility setup, semantic window activation, visual-change waiting,
action receipts, cleanup, retained availability after access release, explicit availability release,
and restoration of GNOME's accessibility setting. Run
`vp run --filter @t3tools/desktop benchmark:computer-use-vm` to compare semantics-only, overview,
balanced, detailed, and focused-region observations. Both commands close temporary applications and
release control before returning.

The benchmark reports captured PNG and JSON payload bytes plus GPT-5.6 original-detail image-token
estimates. The estimate follows OpenAI's documented 32-by-32 patch calculation for the returned
dimensions. It does not claim to measure total turn tokens: semantic JSON is tokenized as text, and
provider or harness transformations can change the final request.

The scripts default to the retained local fixture endpoints and support these overrides:

- `T3_COMPUTER_USE_VM_CDP_URL`
- `T3_COMPUTER_USE_VM_SSH_HOST`
- `T3_COMPUTER_USE_VM_SSH_PORT`
- `T3_COMPUTER_USE_VM_SSH_USER`
- `T3_COMPUTER_USE_VM_SSH_KEY`
- `T3_COMPUTER_USE_VM_KNOWN_HOSTS`
