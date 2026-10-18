# OpenTUI Core 0.6.6 API notes (chat UI)

Source of truth: `node_modules/@opentui/core/**/*.d.ts` (paths below are relative to that package). Items marked **unverified** were not confirmed in the .d.ts or bundled JS. Docs pages at opentui.com were not fetched.

## TextRenderable (`renderables/Text.d.ts`, `renderables/TextBufferRenderable.d.ts`)

- Options: `TextOptions extends TextBufferOptions { content?: StyledText | string }`.
- TextBufferOptions: `fg?`, `bg?`, `selectionBg?`, `selectionFg?` (`string | RGBA`), `selectable?: boolean` (default true), `attributes?: number`, `wrapMode?: "none" | "char" | "word"` (default `"word"`), `textAlign?: "left" | "center" | "right"`, `truncate?: boolean` (default false), `tabIndicator?`, `tabIndicatorColor?`.
- Getters/setters: `content` (get: StyledText, set: `StyledText | string`), `chunks`, `plainText`, `textLength`, `lineCount`, `virtualLineCount`, `fg`, `bg`, `attributes`, `wrapMode`, `textAlign`, `truncate`, `scrollX/scrollY`, `scrollWidth/scrollHeight`.
- Methods: `add(obj, index?)`, `remove(child)`, `clear()`, `getSelectedText()`, `hasSelection()`, `getSelection()`, `drawToBuffer(buffer, x, y)`.
- Events: none typed. Renderables extend EventEmitter; `on/off` are untyped.
- Styled text: `lib/styled-text.d.ts` exports `t` (tagged template, takes `StylableInput = string | number | boolean | TextChunk`), and helpers `bold, italic, underline, strikethrough, dim, reverse, blink`, colors `red, green, ...` (and `brightX`, `bgX`), `fg(color)(input)`, `bg(color)(input)`, `link(url)(input)`, plus `stringToStyledText(s)` and `isStyledText`.
- Wrapping: `wrapMode` defaults to `"word"`. For single-line truncation use `wrapMode: "none"` together with `truncate: true`.
- Selectable text: `selectable` defaults to true and `selectionBg`/`selectionFg` style the selection. Text can be selected with the mouse; copy is not covered here.
- Code (≤10 lines):
```ts
import { TextRenderable, t, bold, fg, dim } from "@opentui/core";
const line = new TextRenderable(renderer, {
  content: t`${bold("you")} ${dim("12:01")}`,
  fg: "#e6e6e6",
  wrapMode: "word",   // or wrapMode:"none", truncate:true for one-line ellipsis
});
parent.add(line);
line.content = t`${fg("#7aa2f7")("assistant")}: hello`; // replace styled content
line.content = "plain string also works";
```

## MarkdownRenderable (`renderables/Markdown.d.ts`)

- Options (`MarkdownOptions`): `content?: string`, `syntaxStyle: SyntaxStyle` (**required**), `fg?`, `bg?` (`ColorInput`), `conceal?` (default true), `concealCode?` (default false), `treeSitterClient?: TreeSitterClient`, `streaming?: boolean` (default false), `tableOptions?`, `renderNode?`, `internalBlockMode?`.
- Streaming: `content` has a getter and a setter. The setter is a no-op when the value is unchanged. Otherwise it calls `updateBlocks()` and `requestRender()`, so it re-parses. Set `streaming = true` while chunks are still arriving. The doc says the trailing block stays unstable in that mode and that the tail should be finalized with `streaming = false` once the stream completes.
- Caveat: every `content` assignment re-runs the parse. Batch token deltas (for example, on a 16-50 ms timer) rather than setting `content` per token. Exact cost per update: **unverified**.
- Other setters: `syntaxStyle`, `fg`, `bg`, `conceal`, `concealCode`, `streaming`, `tableOptions`, `renderNode`, `internalBlockMode`, plus `clearCache()` and `refreshStyles()`.
- Code highlighting: fenced blocks are rendered as `CodeRenderable`. Highlighting needs a `SyntaxStyle` and a `treeSitterClient`. Whether it works when `treeSitterClient` is omitted, and how parsers are fetched, is **unverified**. See the tree-sitter section.
- Code (≤10 lines):
```ts
import { MarkdownRenderable, SyntaxStyle } from "@opentui/core";
const md = new MarkdownRenderable(renderer, {
  content: "",
  syntaxStyle: someSyntaxStyle, // SyntaxStyle instance; see factories below
  streaming: true,
});
md.content += delta;               // setter re-parses; batch deltas
md.streaming = false;              // finalize on turn end
```
- SyntaxStyle factories (`syntax-style.d.ts`) are `SyntaxStyle.create(owner)`, `SyntaxStyle.fromTheme(tokens, owner)`, and `SyntaxStyle.fromStyles(styles, owner)`. Each takes a `NativeResourceOwner` (its exact type is **unverified**), so build the instance once from your app's setup code.

## SelectRenderable (`renderables/Select.d.ts`)

- `SelectOption = { name: string; description: string; value?: any }`.
- Options: `options?: SelectOption[]`, `selectedIndex?`, `wrapSelection?` (default false), `showDescription?` (default true), `showSelectionIndicator?` (default true), `showScrollIndicator?` (default false), `itemSpacing?`, `fastScrollStep?`, `font?`, colors (`backgroundColor`, `textColor`, `focusedBackgroundColor`, `focusedTextColor`, `selectedBackgroundColor`, `selectedTextColor`, `descriptionColor`, `selectedDescriptionColor`), `keyBindings?: SelectKeyBinding[]`, `keyAliasMap?`.
- Actions (`SelectAction`): `"move-up" | "move-down" | "move-up-fast" | "move-down-fast" | "select-current"`. Defaults: up/k, down/j, shift+up, shift+down, return, linefeed.
- Events (`SelectRenderableEvents`, string values): `"selectionChanged"` → `(index: number, option: SelectOption | null)`, `"itemSelected"` → `(index, option)`. Emitted as `this.emit(...)`. Subscribe with `select.on("itemSelected", ...)`. Types are not declared.
- Methods: `getSelectedOption()`, `getSelectedIndex()`, `moveUp(steps?)`, `moveDown(steps?)`, `selectCurrent()`, `setSelectedIndex(i)`, `handleKeyPress(key)`.
- Setters: `options` (the JS setter clamps `selectedIndex` to the new length, so it does **not** reset to 0), `selectedIndex`, `showDescription`, `showScrollIndicator`, `wrapSelection`, `keyBindings`, `keyAliasMap`, colors, `font`, `itemSpacing`, `fastScrollStep`.
- Filtering: set `select.options = filtered` on each keystroke. Filtering is not built in. Reset to the full list with `setSelectedIndex(0)` if you want the first match highlighted (clamping alone keeps the old index).
- Focus: `defaultFocusable = true`. Call `focus()` to receive keys (see Focus section).

## InputRenderable and TextareaRenderable (`renderables/Input.d.ts`, `renderables/Textarea.d.ts`, `renderables/EditBufferRenderable.d.ts`)

- Input options (`InputRenderableOptions`): `value?`, `placeholder?: string`, `maxLength?`, `minLength?`, plus the Textarea options minus height fields. Textarea options (`TextareaOptions`): `initialValue?`, `placeholder?: StyledText | string | null`, `placeholderColor?`, `backgroundColor?`, `textColor?`, `focusedBackgroundColor?`, `focusedTextColor?`, `keyBindings?: KeyBinding[]`, `keyAliasMap?`, `onSubmit?`, and from EditBufferOptions: `cursorStyle?: CursorStyleOptions`, `showCursor?`, `cursorColor?`, `wrapMode?`, `scrollMargin?`, `onCursorChange?`, `onContentChange?`.
- Read text: `value` (Input get/set) and `plainText` (Textarea/EditBuffer getter). Both read the current text.
- Events (Input, `InputRenderableEvents`): `"input"` (payload: the new plain-text string, emitted on every insert, delete, or programmatic `value` set), `"change"` (payload: the string, emitted on `blur()` and on submit if changed), `"enter"` (payload: the string, emitted on submit). Subscribe with `on(...)`. For live filtering use `"input"`.
- Textarea submit: `onSubmit` option, or the `"submit"` action. `SubmitEvent` is empty in the d.ts.
- Actions (`TextareaAction`): `move-left/right/up/down`, `select-*`, `line-home/end`, `buffer-home/end`, `delete-line`, `delete-to-line-end/start`, `backspace`, `delete`, `newline`, `undo`, `redo`, `word-forward/backward`, `delete-word-forward/backward`, `select-all`, `submit`.
- Defaults: Textarea `return` → `newline`, `meta+return` → `submit`. Input's `return` → `submit` (`Input` overrides this, from the bundle).
- Key bindings: `keyBindings: { name, action, ctrl?, shift?, meta?, super? }[]`, set via the `keyBindings` setter or the constructor. `defaultTextareaKeyBindings` is exported.
- Methods: `submit()`, `insertText`, `setText`, `clear` (`clear` on EditBuffer: **unverified** on the subclass), `focus()`, `blur()`, `undo()`, `redo()`.
- Placeholder: `placeholder` getter/setter. Input accepts only a string.
- Cursor styling: `cursorStyle: CursorStyleOptions` (`{ style?, blinking?, color?: RGBA, cursor?: MousePointerStyle }`), `cursorColor` (`RGBA | string`), `showCursor`. `renderer.setCursorStyle()` and `setCursorColor()` also exist.
- Code (≤10 lines):
```ts
import { InputRenderable, InputRenderableEvents } from "@opentui/core";
const input = new InputRenderable(renderer, { placeholder: "Ask...", maxLength: 2000 });
input.on(InputRenderableEvents.INPUT, (text: string) => filterList(text));
input.on(InputRenderableEvents.ENTER, (text: string) => send(text));
input.focus();
// later: input.value = ""; // clears and emits "input"
```

## ScrollBoxRenderable (`renderables/ScrollBox.d.ts`)

- Options (`ScrollBoxOptions`): `stickyScroll?: boolean`, `stickyStart?: "bottom" | "top" | "left" | "right"`, `scrollX?`, `scrollY?` (both boolean), `scrollAcceleration?`, `viewportCulling?`, `rootOptions`, `wrapperOptions`, `viewportOptions`, `contentOptions`, `scrollbarOptions`, `verticalScrollbarOptions`, `horizontalScrollbarOptions`.
- Children: `add(obj, index?)`, `insertBefore`, `remove`, `getChildren()`, `getRenderable(id)`, `scrollChildIntoView(childId)`. Children go into `content`.
- Scroll state: `scrollTop` (get/set), `scrollLeft` (get/set), `scrollHeight` (get), `scrollWidth` (get). Methods: `scrollTo(number | {x, y})`, `scrollBy(delta: number | {x, y}, unit?: "absolute" | "viewport" | "content" | "step")`.
- Layout: `viewport` is a public readonly `BoxRenderable`. Use `viewport.height` as the visible height. `content` and `wrapper` are also readonly. `verticalScrollBar` and `horizontalScrollBar` are public.
- Sticky scroll: `stickyScroll` getter/setter. Its private state (`_hasManualScroll`) is updated in `syncManualScrollState()`, and no public property exposes it.
- Detecting user scrolled up: no public event exists. Derive it: `atBottom = scrollTop >= scrollHeight - viewport.height - 1`. Check this in `onMouseScroll` or each `onUpdate`, or read `stickyScroll` after manual scroll. Treat the derivation as an approximation, since the d.ts does not guarantee it.
- Keys: `ScrollBoxRenderable.handleKeyPress` is defined (scroll keys handled internally; exact bindings **unverified**).
- Code (≤10 lines):
```ts
import { ScrollBoxRenderable } from "@opentui/core";
const chat = new ScrollBoxRenderable(renderer, { stickyScroll: true, stickyStart: "bottom", scrollY: true, flexGrow: 1 });
root.add(chat);
chat.add(messageRenderable);
const atBottom = () => chat.scrollTop >= chat.scrollHeight - chat.viewport.height - 1;
chat.scrollTo({ x: 0, y: chat.scrollHeight }); // jump to bottom
```
- `flexGrow` is a yoga layout setter (`setFlexGrow` in `yoga.d.ts`). Its presence as a constructor option is assumed from `Partial<LayoutOptions>`, not confirmed.

## BoxRenderable (`renderables/Box.d.ts`, `lib/border.d.ts`)

- Options (`BoxOptions`): `backgroundColor?`, `borderStyle?: BorderStyle`, `border?: boolean | BorderSides[]`, `borderColor?`, `focusedBorderColor?`, `customBorderChars?`, `shouldFill?`, `title?`, `titleColor?`, `titleAlignment?`, `bottomTitle?`, `bottomTitleAlignment?`, `focusable?`, `gap?`, `rowGap?`, `columnGap?`.
- Border styles: `BorderStyle = "single" | "double" | "rounded" | "heavy"`. Sides: `"top" | "right" | "bottom" | "left"`.
- Padding: from `RenderableOptions` (inherited from `LayoutOptions`): `padding`, `paddingX`, `paddingY`, `paddingTop/Right/Bottom/Left` (number or `"N%"`).
- Position and overlays: `position?: "absolute" | "relative"` (`PositionTypeString`), plus `top`, `right`, `bottom`, `left` (number, `"auto"`, or `"N%"`), `zIndex?: number`. `visible` and `opacity` also exist. For overlays, `position: "absolute"`, then `top`/`left`, and a higher `zIndex`.
- Setters: `backgroundColor`, `border`, `borderStyle`, `borderColor`, `title`, `titleColor`, `titleAlignment`, `bottomTitle`, `bottomTitleAlignment`, `shouldFill`, `gap`.
- Code (≤10 lines):
```ts
import { BoxRenderable } from "@opentui/core";
const modal = new BoxRenderable(renderer, {
  position: "absolute", top: 3, left: 6, width: 60, height: 12, zIndex: 10,
  border: true, borderStyle: "rounded", title: "Model", padding: 1,
  backgroundColor: "#1a1b26",
});
root.add(modal);
modal.title = "Model (2 of 4)";
modal.visible = false; // hide overlay
```

## CodeRenderable and DiffRenderable (`renderables/Code.d.ts`, `renderables/Diff.d.ts`)

- CodeOptions extends TextBufferOptions: `content?`, `filetype?`, `syntaxStyle: SyntaxStyle` (**required**), `treeSitterClient?`, `conceal?`, `drawUnstyledText?` (default true), `streaming?`, `initialStyledText?`, `baseHighlight?`, `onHighlight?`, `onChunks?`.
- Input: `content` is a plain string. `filetype` is a language id such as `"typescript"`. `updateStreamingPreview(content, styledText)` exists for partial streams.
- Highlighting: async. `isHighlighting`, `highlightingDone: Promise<void>`. Without a `treeSitterClient`, the unstyled text still draws (`drawUnstyledText`). Parser download and location: `lib/tree-sitter/client.d.ts` has `TreeSitterClient({ dataPath, workerPath?, initTimeout? })` with `initialize()`, `preloadParser(filetype)`, and `highlightOnce(content, filetype)`. `getTreeSitterClient()` returns a singleton. `default-parsers.d.ts` exposes `getParsers()`. Whether parsers auto-download at first use is **unverified**.
- DiffRenderable options: `diff?: string` (unified diff text), `view?: "unified" | "split"`, `filetype?`, `syntaxStyle?`, `wrapMode?: "word" | "char" | "none"`, `showLineNumbers?`, `addedBg`, `removedBg`, `contextBg`, `addedSignColor`, `removedSignColor`, `treeSitterClient?`, `syncScroll?`. Setters: `diff`, `view`, `filetype`, `syntaxStyle`, `wrapMode`, `showLineNumbers`.
- Code (≤10 lines):
```ts
import { CodeRenderable, DiffRenderable, SyntaxStyle } from "@opentui/core";
const code = new CodeRenderable(renderer, {
  content: "const x = 1",
  filetype: "typescript",
  syntaxStyle: styleInstance, // built via SyntaxStyle.fromStyles(..., owner); see syntax-style.d.ts
  wrapMode: "word",
});
const diff = new DiffRenderable(renderer, { diff: unifiedDiffText, view: "unified" });
```

## Spinner / animation

- `animation/Timeline.d.ts`: `createTimeline(options?: TimelineOptions, renderer?: CliRenderer)`. `TimelineOptions = { duration?, loop?, autoplay?, onComplete?, onPause? }`. A timeline has `add(target, AnimationOptions, startTime?)`, `call(cb, startTime?)`, `play()`, `pause()`, `restart()`. `AnimationOptions` includes `duration`, `ease`, `loop`, `onUpdate(animation: JSAnimation)`. Pass the renderer explicitly for independent sessions.
- Simplest glyph spinner at ~100 ms: `setInterval` (or the Timeline above). Each tick, set the text and `renderer.requestRender()`. The `renderer.setFrameCallback(async (dt) => {...})` runs per frame, so it is a poor fit for a 100 ms cadence unless you throttle it.
- Keep the frame loop alive: `live?: boolean` in `RenderableOptions`, and `Renderable.live` / `requestLive()` / `dropLive()`. Use these so the renderer keeps drawing while the spinner runs.
- Code (≤10 lines):
```ts
import { TextRenderable } from "@opentui/core";
const FRAMES = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];
const spin = new TextRenderable(renderer, { content: FRAMES[0], fg: "#7aa2f7" });
let i = 0;
const timer = setInterval(() => { spin.content = FRAMES[i++ % FRAMES.length]; renderer.requestRender(); }, 100);
// on stop: clearInterval(timer); spin.destroy?.();
```

## Keyboard input

- `renderer.keyInput: KeyHandler` (`lib/KeyHandler.d.ts`). It is an EventEmitter with `KeyHandlerEventMap = { keypress: [KeyEvent]; keyrelease: [KeyEvent]; paste: [PasteEvent] }`. Use `renderer.keyInput.on("keypress", (key) => ...)`.
- Priority: the internal handler runs global listeners first, then the focused renderable. Calling `key.preventDefault()` or `key.stopPropagation()` in a global listener stops the focused renderable from receiving the key (verified in `emitWithPriority`, `chunk-node-2rg7pskw.js`).
- `KeyEvent` (implements `ParsedKey`): `name: string`, `ctrl`, `meta`, `shift`, `option`, `sequence: string`, `raw: string`, `eventType: "press" | "repeat" | "release"`, `source: "raw" | "kitty"`, `number`, `code?`, `super?`, `hyper?`, `capsLock?`, `numLock?`, `baseCode?`, `repeated?`. Methods: `preventDefault()`, `stopPropagation()`, getters `defaultPrevented`, `propagationStopped`.
- Renderable-level handler: `onKeyDown?: (key: KeyEvent) => void` (option or setter). Also `handleKeyPress?(key)` on a subclass.
- Paste: `renderer.keyInput.on("paste", (e: PasteEvent) => ...)`, with `PasteEvent.bytes: Uint8Array`.
- Code (≤10 lines):
```ts
renderer.keyInput.on("keypress", (key) => {
  if (key.ctrl && key.name === "c") { key.stopPropagation(); exit(); return; }
  if (key.name === "escape" && busy) { key.preventDefault(); cancelTurn(); }
});
```

## Focus

- `focus()` / `blur()` exist on `Renderable` (`Renderable.d.ts`). They respect `focusable` (default true for Input, Textarea, Select, ScrollBox). `focused` getter. Focus change events: `RenderableEvents.FOCUSED = "focused"` and `BLURRED = "blurred"`.
- Renderer-level: `renderer.focusRenderable(r)`, `renderer.blurRenderable(r)`, `renderer.currentFocusedRenderable`, `renderer.currentFocusedEditor`. Renderer events: `FOCUS`, `BLURRED`, `focused_renderable`, `focused_editor` (`CliRenderEvents`).
- Key delivery: keys go to the focused renderable after global listeners, unless those listeners stop propagation (see Keyboard input). Only one renderable is focused at a time, so use `blur()` on the input before focusing a list.

## Terminal size and resize

- `renderer.width` and `renderer.height` are public `number` fields (`renderer.d.ts`). `renderer.terminalWidth` and `terminalHeight` are getters.
- Event: `renderer.on(CliRenderEvents.RESIZE, (width: number, height: number) => ...)`. The bundle emits `this.emit("resize", this.width, this.height)`. The emit is debounced through `requestResize`. Use `renderer.resize(w, h)` only for externally driven resizes (for example, tests or SSH window-change).
- Also `renderable.onSizeChange` and `LayoutEvents.RESIZED` (`"resized"`, payload `{ width, height }`) on individual renderables.

## Color inputs

- `ColorInput = string | RGBA` (`lib/RGBA.d.ts`). Strings go through `parseColor`, which accepts `"transparent"`, CSS named colors (for example `"red"`, `"black"`, with a `CSS_COLOR_NAMES` table), and hex `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`. Invalid hex warns and falls back to magenta.
- `RGBA.fromHex`, `RGBA.fromInts(r,g,b,a?)`, `RGBA.fromValues(r,g,b,a?)` (0-1 floats), `RGBA.fromIndex(n)` (ANSI 256) are available. `hexToRgb`, `rgbToHex`, `parseColor` are exported.

## Text wrapping and truncation

- Summary: `wrapMode: "word" | "char" | "none"` (default `"word"` on TextBuffer). For one-line truncation, `wrapMode: "none"` with `truncate: true`. The truncate ellipsis character is **unverified**.

## Open items (unverified)

- Whether Markdown and Code highlight without an explicit `treeSitterClient`, and whether parsers auto-download.
- `NativeResourceOwner` type needed by `SyntaxStyle` factories.
- Scroll-up detection has no public event. The approach above is derived.
- Markdown update cost per `content` assignment.
- Resize event payload is typed via `EventEmitter` (untyped). Confirmed only at runtime in the bundle.
