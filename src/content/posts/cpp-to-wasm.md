---
title: "shipping C++ to the browser with WebAssembly"
description: "Compiling a performance-critical C++ module to WASM and calling it from a Next.js app — without losing your mind."
date: 2026-04-03
tags: ["wasm", "c++", "typescript", "next.js"]
---

I wanted to expose some order book logic from `hft-sim` in a browser dashboard. The options were: rewrite in TypeScript (no), write a native server and add a round trip (latency), or compile to WebAssembly and call it directly. I went with WASM.

Here's the full setup that actually works.

## Prerequisites

You need the **Emscripten SDK**:

```bash
git clone https://github.com/emscripten-core/emsdk.git
cd emsdk && ./emsdk install latest && ./emsdk activate latest
source ./emsdk_env.sh
```

## Writing the bindable C++ interface

Emscripten's `EMSCRIPTEN_BINDINGS` macro lets you expose C++ classes and functions to JS. The key is keeping your public API simple — complex templates don't cross the boundary cleanly.

```cpp
// wasm_bridge.cpp
#include <emscripten/bind.h>
#include "order_book.hpp"

using namespace emscripten;

EMSCRIPTEN_BINDINGS(order_book_module) {
    class_<OrderBook>("OrderBook")
        .constructor<>()
        .function("addOrder",    &OrderBook::addOrder)
        .function("cancelOrder", &OrderBook::cancelOrder)
        .function("bestBid",     &OrderBook::bestBid)
        .function("bestAsk",     &OrderBook::bestAsk)
        .function("spread",      &OrderBook::spread);
}
```

## Compiling

```bash
emcc wasm_bridge.cpp order_book.cpp \
  -O3 \
  -s WASM=1 \
  -s MODULARIZE=1 \
  -s EXPORT_NAME="createOrderBookModule" \
  -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap"]' \
  --bind \
  -o public/order_book.js
```

This outputs `order_book.js` and `order_book.wasm` — drop both in `public/`.

## Calling from TypeScript

Create a small loader so you only init the module once:

```typescript
// lib/wasm.ts
let modulePromise: Promise<any> | null = null;

export async function getOrderBookModule() {
  if (!modulePromise) {
    const factory = (await import('/order_book.js')).default;
    modulePromise = factory();
  }
  return modulePromise;
}
```

Then in your component:

```typescript
import { getOrderBookModule } from '@/lib/wasm';

export default function BookWidget() {
  const [spread, setSpread] = useState<number | null>(null);

  useEffect(() => {
    (async () => {
      const mod = await getOrderBookModule();
      const book = new mod.OrderBook();
      book.addOrder(/* ... */);
      setSpread(book.spread());
      book.delete(); // important — free heap memory
    })();
  }, []);

  return <div>{spread !== null ? `${spread.toFixed(4)}` : '...'}</div>;
}
```

## Memory management

This trips everyone up. Objects instantiated via `new mod.ClassName()` live on the WASM heap — JavaScript's GC doesn't know about them. **You must call `.delete()`** or you will leak memory on every render.

For long-lived objects, keep a module-level ref:

```typescript
let globalBook: any = null;

async function initBook() {
  const mod = await getOrderBookModule();
  globalBook = new mod.OrderBook();
  // use globalBook, never delete it
}
```

## Performance notes

WASM runs at roughly 1–1.5x native speed on number-crunching tasks. My order book benchmarks on V8:

| Operation | Native (ns) | WASM (ns) | Ratio |
|---|---|---|---|
| addOrder | 112 | 148 | 1.32x |
| bestBid | 18 | 24 | 1.33x |
| spread | 22 | 31 | 1.41x |

For a frontend dashboard this is more than fast enough.

## What didn't work

**`std::unordered_map` with custom allocators** — Emscripten's allocator implementation doesn't respect `alignas` in the same way. I hit subtle bugs and switched to sorted `std::vector` + binary search for the WASM target.

**SIMD intrinsics** — Emscripten supports WASM SIMD via `-msimd128`, but Safari's support was still patchy at time of writing. I disabled it for the browser build.
