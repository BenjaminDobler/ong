# Bug: `ɵɵtextInterpolate1` emitted with missing trailing suffix argument

## Summary

When an Angular template contains a text interpolation with a **static prefix** (text before the
first `{{ }}`), the OXC Angular compiler emits `ɵɵtextInterpolate1` with only **2 arguments**
instead of the required **3**. At runtime the missing third argument is `undefined`, which is
concatenated into the rendered text — producing output like `#1undefined` instead of `#1`.

---

## Affected template pattern

```html
<span>#{{ index() + 1 }}</span>
```

Any text node that has a static prefix before the first interpolation is affected. Examples:

```html
<span>#{{ idx }}</span>
<span>Item #{{ i + 1 }}:</span>
<button>Remove #{{ idx }}</button>
```

The bug does **not** affect:

- Plain interpolation with no surrounding text: `{{ expr }}` → correctly uses `ɵɵtextInterpolate(v0)`
- Interpolation with both prefix and suffix non-empty: handled via a different code path
- Interpolation with whitespace surrounding strings (which are non-empty → preserved correctly)

---

## Runtime symptom

Given:

```html
<!-- Parent (inside @for loop) -->
<app-question-card [index]="$index" />

<!-- Child component: question-card.component.html -->
<span>#{{ index() + 1 }}</span>
```

**Angular CLI output:** `#1`, `#2`, `#3`, …
**OXC compiler output:** `#1undefined`, `#2undefined`, `#3undefined`, …

The test case in the existing test suite also reproduces it:

```
template: `@for (item of items; track item.id; let idx = $index) {
  <button (click)="remove(idx)">Remove #{{ idx }}</button>
}`
```

Existing snapshot (`for_listener_with_index`) already contains the **wrong** output:

```js
i0.ɵɵtextInterpolate1("Remove #",ɵ$index_1_r2);  // ← 2 args, WRONG
```

The correct output should be:

```js
i0.ɵɵtextInterpolate1("Remove #", ɵ$index_1_r2, "");  // ← 3 args
```

---

## Root cause

### Angular runtime requirement

`ɵɵtextInterpolate1` always requires **3 positional arguments**:

```ts
function ɵɵtextInterpolate1(prefix: string, v0: any, suffix: string)
```

Internally it delegates to `interpolation1(lView, prefix, v0, suffix)` which does:

```ts
return prefix + renderStringify(v0) + suffix
```

When `suffix` is `undefined` (JS), the result is `prefix + value + "undefined"`.

Source: `@angular/core/fesm2022/core.mjs`, line ~25102.

### How the OXC compiler processes interpolation strings

An Angular interpolation is stored as two parallel arrays:

- `strings`: static text segments (always `expressions.len() + 1` elements)
- `expressions`: dynamic values

For `#{{ idx }}`:
- `strings = ["#", ""]`
- `expressions = [idx]`

### The bug: trailing empty string is incorrectly dropped

In `crates/oxc_angular_compiler/src/pipeline/phases/reify/mod.rs`, the
`reify_interpolation` function (line ~1107) handles the trailing string at lines ~1147–1163:

```rust
if ir_interp.strings.len() > ir_interp.expressions.len() {
    if let Some(trailing) = ir_interp.strings.last() {
        if !trailing.is_empty() || has_extra_args {  // ← the condition
            args.push(/* trailing string */);
        }
    }
}
```

This drops the trailing string when it is empty (`""`) **and** `has_extra_args` is `false`.

The `has_extra_args` parameter was designed for cases where the caller appends extra arguments
**after** the interpolation args — e.g. a sanitizer for property bindings or a namespace for
attribute bindings. In those cases the trailing `""` is needed as a positional separator.

For text interpolation (`UpdateOp::InterpolateText`), the call site at line ~878–884 passes
`has_extra_args: false`:

```rust
UpdateOp::InterpolateText(interp) => {
    let (args, expr_count) = reify_interpolation(
        allocator,
        &interp.interpolation,
        expressions,
        root_xref,
        false,   // ← bug: causes trailing "" to be dropped
    );
    Some(create_text_interpolate_stmt_with_args(allocator, args, expr_count))
}
```

As a result, for `#{{ idx }}`:

1. `reify_interpolation` returns `args = ["#", idx]` and `expr_count = 1`
2. `create_text_interpolate_stmt_with_args` sees `expr_count == 1` but `args.len() == 2`
   (not 1), so it correctly selects `ɵɵtextInterpolate1` (the N≥1 variant)
3. But only 2 args are passed; `ɵɵtextInterpolate1` expects 3

### Why the simple case `{{ expr }}` works

For plain `{{ expr }}` with no prefix/suffix:
- `strings = ["", ""]`, `expressions = [expr]`
- `strings.iter().all(|s| s.is_empty())` is `true` → takes the early-return branch (line ~1127)
  that pushes only `expr` → `args = [expr]`, `args.len() == 1`
- `create_text_interpolate_stmt_with_args` sees `expr_count == 1, args.len() == 1`
  → uses `ɵɵtextInterpolate(v0)` (no surrounding strings needed) ✓

The bug only manifests when there is at least one non-empty surrounding string.

---

## Affected files

| File | Line | Description |
|------|------|-------------|
| `crates/oxc_angular_compiler/src/pipeline/phases/reify/mod.rs` | ~883 | `has_extra_args: false` passed for text interpolation |
| `crates/oxc_angular_compiler/src/pipeline/phases/reify/mod.rs` | ~1147–1163 | Logic that drops trailing `""` when `has_extra_args` is false |
| `crates/oxc_angular_compiler/src/pipeline/phases/reify/mod.rs` | ~1195–1207 | Same logic for `AngularExpression::Interpolation` variant |
| `crates/oxc_angular_compiler/tests/snapshots/integration_test__for_listener_with_index.snap` | 23 | Snapshot already encodes the wrong 2-arg output |

---

## Proposed fix

Change `has_extra_args` from `false` to `true` in the `InterpolateText` match arm.

**File:** `crates/oxc_angular_compiler/src/pipeline/phases/reify/mod.rs`

```diff
 UpdateOp::InterpolateText(interp) => {
-    // Handle multiple interpolations like "{{a}} and {{b}}"
+    // Handle multiple interpolations like "{{a}} and {{b}}" or "prefix {{a}} suffix"
+    // has_extra_args: true ensures the trailing empty string is preserved.
+    // ɵɵtextInterpolate1(s0, v0, s1) always requires all 3 positional args —
+    // the suffix must not be dropped even when it is empty.
     let (args, expr_count) = reify_interpolation(
         allocator,
         &interp.interpolation,
         expressions,
         root_xref,
-        false,
+        true,
     );
     Some(create_text_interpolate_stmt_with_args(allocator, args, expr_count))
 }
```

### Why this is safe

`has_extra_args: true` only affects the trailing empty-string logic. For the simple case
`{{ expr }}` (all surrounding strings empty), the early-return branch at line ~1127 fires before
the trailing-string logic, so `true` vs `false` makes no difference there.

For cases that reach the trailing-string logic:
- `has_extra_args: true` → always emit the trailing string (even `""`)
- This matches the Angular runtime's expectation: `ɵɵtextInterpolate1(s0, v0, s1)` always
  consumes `s1`, so `""` is the correct value for an empty suffix

There are no extra args appended after text interpolation (no sanitizer, no namespace), so
keeping the trailing `""` does not break any positional argument alignment.

### Snapshot to update

`crates/oxc_angular_compiler/tests/snapshots/integration_test__for_listener_with_index.snap`
line 23:

```diff
-    i0.ɵɵtextInterpolate1("Remove #",ɵ$index_1_r2);
+    i0.ɵɵtextInterpolate1("Remove #",ɵ$index_1_r2,"");
```

---

## Suggested new test case

Add a test that explicitly covers a static prefix in a text node:

```rust
#[test]
fn test_text_interpolation_with_prefix() {
    let js = compile_template_to_js(
        r#"<span>#{{ index }}</span>"#,
        "TestComponent",
    );
    // Must emit 3 args: prefix, value, suffix
    assert!(
        js.contains(r#"ɵɵtextInterpolate1("#,""#),
        "ɵɵtextInterpolate1 should have prefix arg"
    );
    assert!(
        !js.contains(r#"ɵɵtextInterpolate1("#",ctx.index)"#),
        "Missing trailing suffix: ɵɵtextInterpolate1 must have 3 args"
    );
    insta::assert_snapshot!("text_interpolation_with_prefix", js);
}
```

Expected snapshot output:

```js
function TestComponent_Template(rf,ctx) {
  if ((rf & 1)) { i0.ɵɵtext(0); }
  if ((rf & 2)) { i0.ɵɵtextInterpolate1("#",ctx.index,""); }
}
```

---

## How to reproduce

1. Clone the repository
2. Create a minimal Angular component:

```typescript
// test.component.ts
@Component({
  template: `<span>#{{ index() + 1 }}</span>`,
})
export class TestComponent {
  readonly index = input.required<number>();
}
```

Or use the existing test template:

```typescript
// Already in integration_test.rs at line 1234
`@for (item of items; track item.id; let idx = $index) { <button>Remove #{{ idx }}</button> }`
```

3. Compile and inspect the output — look for `ɵɵtextInterpolate1` with only 2 arguments
4. Run the component in a browser — the rendered text will have `undefined` appended

---

## Verification

After applying the fix, run:

```bash
cargo test -p oxc_angular_compiler test_for_listener_with_index -- --nocapture
```

The snapshot will need to be updated:

```bash
cargo insta review
```

Also add and run the new test `test_text_interpolation_with_prefix`.

---

## Impact

- Affects any template with a static prefix before the first interpolation in a text node
- No impact on property/attribute/style interpolations (those paths already preserve the trailing
  string correctly via their own `has_extra_args` flags)
- No impact on plain `{{ expr }}` interpolations (handled by the early-return branch)
