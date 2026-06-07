---
title: "cache-line optimization in C++ order books"
description: "How aligning hot data to 64-byte cache lines cut latency by 40% in my HFT simulator."
date: 2026-05-12
tags: ["c++", "performance", "hft"]
sourceNote: "Code for this post is available on GitHub."
---

Building a high-frequency trading simulator forced me to think carefully about memory layout. This post walks through the cache-line alignment techniques I used in `hft-sim` to bring order book update latency down from ~180ns to ~110ns on my test machine.

## The problem with naive structs

A typical order book entry looks innocent enough:

```cpp
struct Order {
    uint64_t id;
    double   price;
    uint32_t quantity;
    Side     side;      // enum: BID or ASK
    Status   status;    // enum: OPEN, FILLED, CANCELLED
};
```

The issue: `sizeof(Order)` comes out to 24 bytes. When you pack thousands of these into a vector and iterate hot paths, you get roughly **2.67 orders per cache line**. That fractional alignment means almost every third access pulls in a new cache line unnecessarily.

## Cache lines 101

Modern CPUs load memory in 64-byte chunks called *cache lines*. If your struct straddles two cache lines, a single read can trigger two memory fetches — a potentially 100x latency penalty compared to an L1 cache hit.

```cpp
// Check alignment at compile time
static_assert(sizeof(Order) % 64 == 0 || alignof(Order) >= 8);
```

The fix is to pad or repack your struct so hot fields sit together and the whole thing is a multiple of 64 bytes.

## The aligned order struct

```cpp
struct alignas(64) Order {
    // ── hot fields (read every update) ─────────────── 24 bytes
    double   price;       // 8
    uint64_t id;          // 8
    uint32_t quantity;    // 4
    Side     side;        // 1
    Status   status;      // 1
    uint8_t  _pad0[2];    // align to 8

    // ── warm fields (read on fill/cancel) ──────────── 16 bytes
    uint64_t timestamp_ns;
    uint64_t fill_id;

    // ── cold fields (rarely read) ───────────────────── 24 bytes
    char     symbol[8];
    uint32_t trader_id;
    uint32_t flags;
    uint8_t  _pad1[8];
    // total: 64 bytes, exactly one cache line
};

static_assert(sizeof(Order) == 64);
static_assert(alignof(Order) == 64);
```

By grouping hot fields at the front, the CPU prefetcher pulls in exactly the data you need — the cold fields stay in the same cache line but don't pollute adjacent entries.

## The order book array

For the book itself, use `std::vector` with a custom allocator or just over-align on construction:

```cpp
#include <memory>

// 64-byte aligned allocator
template<typename T>
struct AlignedAllocator {
    using value_type = T;

    T* allocate(std::size_t n) {
        void* ptr = nullptr;
        if (posix_memalign(&ptr, 64, n * sizeof(T)) != 0)
            throw std::bad_alloc{};
        return static_cast<T*>(ptr);
    }

    void deallocate(T* p, std::size_t) noexcept {
        free(p);
    }
};

using OrderBook = std::vector<Order, AlignedAllocator<Order>>;
```

## Benchmarking the difference

I benchmarked 10M sequential reads over a book of 100k orders using `perf stat`:

| Layout | L1 misses | Avg latency |
|---|---|---|
| Naive (24B) | 31.2M | 178 ns |
| Aligned (64B) | 8.4M | 112 ns |
| Aligned + prefetch | 3.1M | 94 ns |

The prefetch variant uses `__builtin_prefetch` to hint the CPU a few entries ahead:

```cpp
for (std::size_t i = 0; i < book.size(); ++i) {
    if (i + 8 < book.size())
        __builtin_prefetch(&book[i + 8], 0, 1);
    process(book[i]);
}
```

## What's next

The next bottleneck is the price level aggregation step, which involves a hash map traversal that's essentially cache-hostile by design. I'm exploring a sorted flat array with binary search — more on that in the next post.
