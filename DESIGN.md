# DESIGN.md

Visual direction, fixed now so the UI built later is consistent. This is a
constraint for a later phase. No UI is built in this phase.

## Primitives

- shadcn@4.19.0 (CLI)
- radix-ui@1.6.7
- lucide-react@1.33.0

We use shadcn's primitives but **not** its default theme.

## Direction

An operations console. High information density — closer to Linear or the
Stripe Dashboard than to a marketing site. This is a tool venue staff use all
day.

## Tokens

Defined in Tailwind 4 CSS-first `@theme`. There is no `tailwind.config.js`.

| Token | Value |
| --- | --- |
| `--radius` | `4px` |
| Neutral ramp | stone (not zinc) |
| Accent | amber — a single accent |
| Borders | 1px hairline |
| Card shadows | none |
| Data font | Geist Mono, for booking IDs, timestamps and money |
| Base size | 14px |
| Table size | 13px |
| Row height | compact |
| Status | small uppercase mono labels, not coloured pills |
