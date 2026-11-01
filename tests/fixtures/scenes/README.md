# Synthetic scenes (Phase 0)

Self-contained stand-ins for Claude-written scene code, used to test the local scene renderer
(`src/main/scene`). They are **not** client styles and are not copies of any client project; they only
exercise the same techniques the two example skills rely on:

| Folder | Entry adapter | Exercises |
| --- | --- | --- |
| `design/` | `static` | HTML/CSS/SVG design → PNG still; font loaded from a job file (`@font-face`) |
| `podcast-like/` | `scene` (`window.SCENE.render(t)`) | Word reveals with blur, frame-quantised counter, word-synced captions, `?alpha=1` / `?nocap=1` modes, a fast bar for motion blur |
| `saas-like/` | `registry` (`SCENES` + `renderAt(T)` + `camAt(T)`) | Absolute timeline with several scenes, post-capture camera push, 300 particles on a canvas at device scale |
| `escape/` | `scene` | Sandbox escape attempts (network, files, Node, navigation, pop-ups, workers, WebRTC…) |
| `faults/` | `scene` | Endless loops, memory bombs, exceptions, timers and the virtual clock |

Every animated scene draws a "time code" block in its top-left corner: an opaque 4×4 CSS-px square
whose RGB bytes are round(t × 100000) (24-bit). Tests read it back from rendered and encoded frames to
prove each frame shows exactly the scene time i·den/num.

`fonts/InterDisplay-ExtraBold.otf` is Inter (SIL Open Font License 1.1; see `INTER-LICENSE.txt`).
