# `remove()`

Completely removes EXIF metadata from a JPEG image.

## Signature

```ts
function remove(input: string, output: string): Promise<void>
```

## Example

```ts
import { remove } from "imgmeta-js";

await remove("input.jpg", "stripped.jpg");
```
