import { Data, Effect } from "effect";

/** The splitter's response was cut off or could not be read. */
export class FramesBroken extends Data.TaggedError("FramesBroken")<{ readonly message: string }> {}

const u32 = (bytes: Uint8Array, at: number) => new DataView(bytes.buffer, bytes.byteOffset + at, 4).getUint32(0);

/**
 * Reads the splitter's response body: a uint32 page count, then per page a uint32 length and that many bytes.
 * Runs `onPage` for each page in order as soon as it is complete, so only about one page is held at a time.
 */
export const readFrames = <E>(
  body: ReadableStream<Uint8Array>,
  onPage: (index: number, page: Uint8Array) => Effect.Effect<void, E>,
): Effect.Effect<number, FramesBroken | E> =>
  Effect.gen(function* () {
    const reader = body.getReader();
    let buffer = new Uint8Array(0);
    let count: number | undefined;
    let index = 0;
    for (;;) {
      const next = yield* Effect.tryPromise({
        try: () => reader.read(),
        catch: (error) => new FramesBroken({ message: String(error) }),
      });
      if (next.done) break;
      const joined = new Uint8Array(buffer.length + next.value.length);
      joined.set(buffer);
      joined.set(next.value, buffer.length);
      buffer = joined;
      if (count === undefined && buffer.length >= 4) {
        count = u32(buffer, 0);
        buffer = buffer.slice(4);
      }
      while (count !== undefined && index < count && buffer.length >= 4 && buffer.length >= 4 + u32(buffer, 0)) {
        const end = 4 + u32(buffer, 0);
        const page = buffer.slice(4, end);
        buffer = buffer.slice(end);
        yield* onPage(index, page);
        index++;
      }
    }
    if (count === undefined || index < count)
      return yield* new FramesBroken({ message: `Response ended after ${index} of ${count ?? "?"} pages` });
    return count;
  });
