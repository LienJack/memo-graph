# Component Guidelines

> How components are built in this project.

---

## Overview

Components expose authority and recovery state rather than hiding it behind generic spinners or empty states. The semantic DOM is the product path; visual layers such as Graph canvases are enhancements.

## Component Structure

- Keep data parsing, request cancellation, and URL sanitization outside JSX.
- Prefer small presentational components with explicit props over implicit module state.
- Use semantic landmarks, headings, lists, labels, and native controls before ARIA roles.
- Render memory and evidence strings through React text interpolation only. Never use `dangerouslySetInnerHTML`.

## Props Conventions

- Define named prop types next to the component.
- Use discriminated unions for mutually exclusive states.
- Accept callbacks named for user intent (`onOpenHealth`, `onClearFilters`) rather than service objects.
- Avoid optional booleans when a named mode communicates the state more precisely.

## Styling Patterns

The v1 shell uses reviewed global CSS in `src/styles/workbench.css`. Use project variables, restrained motion, minimum 44px targets, readable contrast, narrow-window reflow, and a reduced-motion-safe default. Do not add a second styling system without design review.

## Accessibility

- Each view has one focusable `h1`; route changes focus it.
- Modal dialogs trap focus, close with Escape, and restore their trigger.
- Async announcements use one polite live region and avoid repeating unchanged state.
- Every Graph canvas action has an equivalent semantic list/detail action.
- Verify keyboard, focus, narrow layout, 200% zoom, and markup-as-text behavior in Chromium.

## Common Mistakes

- Do not represent blocked or filtered-empty as an empty memory library.
- Do not put operational mutation controls in Runtime Health.
- Do not leave stale content visually indistinguishable from current authority.
