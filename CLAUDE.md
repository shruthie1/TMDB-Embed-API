# CLAUDE.md

**Read `AGENTS.md` first.** It holds the measured operational context for this
repo — how to run it, what has already been ruled out, and the numbers behind
each decision. This file carries only the things that must not be re-litigated.

Do not duplicate `AGENTS.md` content here; update it there instead.

## Non-negotiables

1. **Never lose audio or video information to save latency.**
   An unlabelled stream is invisible to the language-first ranking, so dropping
   a language tag does not give a slower Telugu result — it gives no Telugu
   result. Blocking work is acceptable; silent information loss is not.
   (Stated by the user after a non-blocking ffprobe change was reverted.)

2. **The standing requirement is Telugu.** Telugu-first ranking is the point of
   the language work, not an incidental feature.

3. **Never claim fixed / verified / working from reading code.** Exercise the
   surface the user actually looks at and paste the output. If the stronger
   check is unavailable, say why and label the result `unverified`.
   An honest "unverified" beats a confident wrong.

4. **Do not disable `masterMatchesTitle`** (`providers/netmirror.js:613`, called at `:934`). It
   catches NetMirror's rate-limit response, which arrives as HTTP 200 with a
   shared 600s clip in place of the film. Upstream has no such guard.
   But note the title IS really there — a throttle wants backoff, not
   permanent rejection. See `AGENTS.md`.

5. **Do not sweep or benchmark newtv.** Each burst of requests poisons every
   later measurement for an unknown window; that is how this session wrongly
   concluded the path was dead. Test with ONE request and say it was one.

6. **`/tmp/api8790.log` uses carriage returns.** Read it as
   `tr '\r' '\n' < /tmp/api8790.log | grep -a ...`.

7. **Git:** work on `main`. No commits, branches, pushes or merges unless the
   user asks for them.

## Working style

- Measure before deciding, and put the numbers in the answer.
- Finish the whole ask, including adjacent call sites. Narrow scope only if the
  user narrows it — and say so explicitly if something is left out.
- Proceed without checking in for reversible development work. Ask once before
  anything irreversible.
- Prefer the smallest root-cause change. No unrelated cleanup or refactors.
- When a claim of mine turns out wrong, correct it plainly and move on.
