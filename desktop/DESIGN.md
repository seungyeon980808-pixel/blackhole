# Ya Desktop visual contract

## Product premise

- User: a Korean teacher repeatedly reviewing records captured by voice.
- Primary job: identify the current record, verify its interpreted schedule, and understand whether it can be approved.
- Working material: an approval document tray with a persistent queue and a large inspection surface.
- Environment: Korean Windows desktop, keyboard and mouse, variable window size and display scaling, repeated use under visual fatigue.

## Tokens

- Navigation `#172238`: stable global location.
- Canvas `#F5F7FA`: quiet working background.
- Surface `#FFFFFF`: document and queue surfaces.
- Ink `#172033`, muted `#5D6878`: readable text hierarchy.
- Selection `#245FBD` and `#E8F0FC`: current record and keyboard focus context.
- Attention `#8A5B00` and `#FFF3CF`: disconnected or pending information.

Typography uses Windows-native `Segoe UI Variable`, Korean `Malgun Gothic`, and `Segoe UI` fallback. Body text is 14/20px, secondary text is at least 12/16px, section titles are 16–18px semibold, and the record title is 28/36px semibold.

Spacing uses a 4px base. Major regions have square edges, controls use a restrained 5px radius, and shadows are omitted. Lines separate durable information structures rather than decorating every field.

## Signature and restraint

The signature is a narrow blue document rail that physically connects the selected queue record to the inspection state. The rest of the interface stays quiet.

No gradients, floating card grid, decorative all-caps labels, monospace metadata, ornamental English, glow, glass, or repeated pill treatment. Status is shown once per relevant record and never by color alone.

## Responsive structure

```text
wide:    navigation | queue | record inspection
medium:  narrow nav | queue | two-column inspection
narrow:  top nav
         queue
         record inspection
```

The queue remains persistent on desktop widths. Below 800px, regions reflow vertically instead of clipping.

## Quick capture

The navigation rail may include a compact **빠른 기록** section. It is a capture surface for short raw notes, not a second approval queue or Wiki editor. The section shows whether the local Google Drive sync Inbox is connected, disables capture when it is unavailable, and confirms the generated filename after a successful save. It must remain visually subordinate to the approval queue and preserve the existing navigation, queue, and inspection hierarchy.
