# Third-party notices

Parts of this project are adapted from the following open-source software.

## opencode (https://github.com/sst/opencode)

Used in: `server/native/tools/edit-match.mjs` (replacer cascade ported from `packages/opencode/src/tool/edit.ts`); `server/native/tools/line-endings.mjs` (line-ending and BOM helpers from `packages/opencode/src/tool/edit.ts` and `src/util/bom.ts`); `server/native/providers/overflow.mjs` (context-overflow patterns from `packages/llm/src/provider-error.ts`); `server/native/providers/retry-policy.mjs` (retryable-message patterns and jitter from `packages/opencode/src/session/retry.ts`); ideas for `server/native/project-instructions.mjs`, `server/native/tool-output-spill.mjs` and context pruning.

```
MIT License

Copyright (c) 2025 opencode

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
