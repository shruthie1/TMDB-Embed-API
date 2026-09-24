# Player architecture

`Player.jsx` reached 887 lines with 26 state variables, 17 effects and 34
write sites into a handful of shared values. Every regression in the player
had the same shape: two effects writing the same state from different events,
whichever ran last winning.

The logic was sound and measured; the ownership was not. So this is a
decomposition, not a rewrite — each behaviour keeps its rules and gains a
single owner.

## Ownership

| Hook | Owns | Nothing else may write |
|---|---|---|
| `useResolve` | the SSE resolve: `stream`, `sources`, `log`, `stage`, `error` | `stream`, `log` |
| `useHls` | attaching hls.js: `levels`, `currentLevel`, `autoLevel`, `audioTracks` | `levels`, `currentLevel` |
| `useRecovery` | the stall ladder: `stallStage`, `recovery` | `stallStage`, `recovery` |
| `useControlVisibility` | `visible` and the hide timer | `visible` |
| `useSubtitles` | `subs`, `currentSub`, `subUrl`, `subPrefs` | all of them |
| `useWatchProgress` | saving position, next-episode lookup | — |

`Player.jsx` composes them and renders. It holds no timers and no derived
playback state of its own.

## Rules that came from real defects

Each of these cost a user-visible bug; they are requirements, not preferences.

1. **One writer per value.** A second writer is how "controls flash", "sheet
   auto-hides" and "tap does not toggle" all happened.
2. **No `mousemove` wake-up.** Touch devices synthesise one alongside every
   tap, which raced the tap handler.
3. **Control visibility moves one way on tap** — tap shows, timeout hides.
   A toggle can be raced; a one-way function cannot.
4. **The gesture surface keeps pointer-events while the bar is faded**, or a
   tap on hidden controls reaches the `<video>` and nothing happens.
5. **Recovery gates on fragment PROGRESS, not elapsed time.** An 8s timer
   aborted healthy 6-10s segment fetches and made playback impossible.
6. **A stream ending after `done` is not a failure** — it is the signal that
   no more alternates are coming.
7. **Quality is a property OF a source.** Switching source replaces the
   ladder; it must not be carried over.
8. **Never infer a URL's type from its path.** Provider URLs are opaque
   signed tokens; the HLS tag declares the type.
