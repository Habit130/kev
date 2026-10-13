# Precision Workbench

Project-specific visual reference for the local Kev frontend. This is not a generated Skill master. Rejected Skill output is not persisted.

## Skill use

Installed skill: global `ui-ux-pro-max`. Queries were re-run on 2026-10-09 against the local dataset and checked against installed Next.js 16.3.5 docs (`node_modules/next/dist/docs/`), not the skill's Next 16.2 notes.

| Query | Result identity | Decision |
| --- | --- | --- |
| `scientific inference workbench precision --design-system` | Minimal Single Column landing page; Neumorphism; remote Inter; orange-on-dark | Rejected. Landing layout, soft UI, remote font, and wellness styling do not match a two-pane workbench. |
| `developer tools dashboard --design-system` | FAQ/Documentation landing; Dark Mode (OLED); remote IBM Plex / JetBrains Mono; green CTA | Rejected. Dark-only, glow, remote fonts, and green-as-success are out of scope. |
| `keyboard focus visible --domain ux` | Visible focus ring; focus not fully obscured; keyboard order; native button semantics | Adopted. Solid ring, scroll padding, no geometry-changing press. |
| `reduced motion animation --domain ux` | Honor `prefers-reduced-motion`; no continuous decoration | Adopted for nonessential spin, pulse, and transitions. Textual busy/status remains. Hero and continuous motion were not adopted. |
| `global font layout --stack nextjs` | `next/font` on the root layout; targets Next 16.2 | Rejected as an implementation. Installed 16.3.5 docs confirm `next/font` self-hosts by fetching font files. This delivery uses the system sans/mono stacks only, set in `globals.css`, so builds do not request fonts. |

Phosphor was not installed. Lucide remains the icon set.

## Identity

A calm scientific instrument: state, then questions, then inspectable probabilities. Signature elements are a shared alignment, section rules, type labels, and 0–1 distribution bars. No chat composer, hero, KPI cards, purple gradient, glass, neumorphism, or remote asset.

## Themes

Explicit `light` or `dark` on `documentElement` wins over `prefers-color-scheme`. A missing saved setting stays light. The workbench preference is read for first paint without writing the settings file. Classic and Chess share the tokens; they do not adopt the workbench model session.

### Light

| Role | Value | Use |
| --- | --- | --- |
| background | `#F3F0E8` | paper page |
| card / popover | `#FBFAF6` | section surface |
| foreground | `#1C1916` | task text |
| muted | `#E7E1D4` | quiet fills |
| muted-foreground | `#3E3933` | secondary text, including helpers |
| primary / ring | `#0C4C52` | actions and focus |
| primary-foreground | `#F4FFFE` | text on actions |
| primary-hover | `#0A3E43` | action hover, no geometry change |
| border / input | `#6E665C` | boundaries, at least 3:1 |
| ready | `#0E5A36` on `#E4F1E8` | model ready, not probability |
| warning | `#6A3E00` on `#F6E6C4` | mismatch, recovery, failed run |
| destructive | `#8C1D1D` on `#F8E6E4` | errors and destructive actions |
| distribution | `#1A3C44` on `#DDD6C8` | 0–1 bar, same ink for every option |

### Dark

| Role | Value | Use |
| --- | --- | --- |
| background | `#171B1F` | graphite page |
| card | `#22282D` | section surface |
| foreground | `#F4F1EA` | task text |
| muted-foreground | `#D4CDC2` | secondary text |
| primary / ring | `#8FE0D6` | actions and focus |
| primary-foreground | `#062826` | text on actions |
| border | `#8D98A3` | boundaries |
| ready | `#8FD4AE` | resident ready |
| warning | `#F0C36A` on `#3A2C14` | recovery and mismatch |
| destructive | `#FFB4A8` | errors |
| distribution | `#D7E4E2` on `#2A3338` | bars, not a success green |

## Type

System sans, with PingFang SC, Hiragino Sans GB, Noto Sans SC, Microsoft YaHei, and Source Han Sans SC as local fallbacks. No font file is requested.

| Role | Size | Use |
| --- | --- | --- |
| task / form / help | 14px (`text-sm`) | instructions, notices, field labels, button labels |
| secondary metadata | 12px (`text-xs`) | IDs, timestamps, kickers, latency, token counts |
| answer | 16px | chosen option, p(yes), expected level |
| chess coordinate | 9px | board file/rank only; `data-pw="coordinate"` |

Mono and tabular numerals are for IDs, JSON, probabilities, and latency. Chinese prose, including text-mode state, uses sans. JSON mode may use mono.

## Space, radius, motion

Spacing follows a 4/8px scale: 4, 8, 16, 24, 32. Radius is 4, 6, or 8px. Sections use one border and a rule, not a card inside a card. Shadows are not a hierarchy device.

Hover and press change color or opacity only. Focus is a 2px solid ring, offset from the control. `prefers-reduced-motion: reduce` removes nonessential animation and transitions. Busy and loading still show text.

## States

Active, hover, focus, pressed, disabled, busy, empty, success/ready, warning, and error use the roles above. Ready is not applied to a probability. A selected or shown option also has a text suffix (`selected` / `shown`), not color alone. Status text remains in `role="status"` or `role="alert"`.

## Responsive

Desktop Run keeps input and results side by side from the `xl` breakpoint. Narrower widths stack in task order: navigation, input, results. Library and history panels stay in the viewport; JSON and permutation tables scroll inside a labelled region. The chess board stays square. Sticky Classic actions keep content clear with bottom padding and `scroll-padding`. Compact widths (under 1024px) give primary and destructive buttons at least 44×44 CSS pixels. Other icon controls stay at least 24×24. Chess squares follow the board, not the 44px rule.

## Components

Run, Task library, History, Classic, and Chess use these tokens through `globals.css` and the shared button, input, and textarea primitives. Workbench handlers, storage, and API calls are unchanged.
