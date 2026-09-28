---
name: accessible-ui
description: Accessible markup and interaction for UI components
tier: library
domains: [frontend]
trigger: ui, component, page, layout, button, form, modal, dialog, menu, nav, sidebar, drawer, dashboard, redesign
---
- Use semantic elements: `button` for actions, `a` for navigation, headings in order, lists
  for lists, `dl` for label/value pairs.
- Every control has an accessible name (visible label or `aria-label`); icons alone need one.
- Disabled or locked items still explain why in text, not only through an icon or colour.
- Keyboard: everything reachable and operable with Tab/Enter/Space/Escape; visible focus;
  hidden off-canvas panels are `inert` or `aria-hidden` so they cannot be focused.
- Colour contrast at least 4.5:1 for body text; never convey state by colour alone.
- Respect `prefers-reduced-motion` for animations.
