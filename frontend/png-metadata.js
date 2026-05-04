/**
 * Forge Studio — PNG Metadata Module
 * by ToxicHost & Moritz
 *
 * Reads and writes PNG tEXt chunks for A1111-compatible
 * generation parameter embedding. Pure JS, no dependencies.
 *
 * Usage:
 *   // Write metadata to a canvas export:
 *   const blob = await PngMetadata.exportWithMetadata(canvas, { parameters: "..." });
 *
 *   // Read metadata from a File or Blob:
 *   const meta = await PngMetadata.read(file);
 *   // meta.parameters => "masterpiece, 1girl, ...\nSteps: 20, Sampler: ..."
 *
 *   // Parse an A1111 infotext string into fields:
 *   const fields = PngMetadata.parseInfotext(meta.parameters);
 *   // fields.prompt, fields.negativePrompt, fields.seed, etc.
 */

"use strict";

window.PngMetadata = (() => {

    // ════════════════════════════════════════════
    // PNG CONSTANTS
    // ════════════════════════════════════════════

    const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

    // CRC32 lookup table (built once)
    const _crcTable = (() => {
        const t = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            t[n] = c;
        }
        return t;
    })();

    function _crc32(buf) {
        let crc = 0xFFFFFFFF;
        for (let i = 0; i < buf.length; i++) crc = _crcTable[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
        return (crc ^ 0xFFFFFFFF) >>> 0;
    }

    // ════════════════════════════════════════════
    // ENCODE HELPERS
    // ════════════════════════════════════════════

    function _textToBytes(str) {
        return new TextEncoder().encode(str);
    }

    function _bytesToText(buf) {
        return new TextDecoder("latin1").decode(buf);
    }

    function _readUint32(data, offset) {
        return (data[offset] << 24 | data[offset + 1] << 16 | data[offset + 2] << 8 | data[offset + 3]) >>> 0;
    }

    function _writeUint32(val) {
        return new Uint8Array([(val >>> 24) & 0xFF, (val >>> 16) & 0xFF, (val >>> 8) & 0xFF, val & 0xFF]);
    }

    // ════════════════════════════════════════════
    // BUILD tEXt CHUNK
    // ════════════════════════════════════════════

    /**
     * Build a PNG tEXt chunk: keyword \0 text
     * Returns Uint8Array: [length(4)] [type(4)] [data(N)] [crc(4)]
     */
    function _buildTextChunk(keyword, text) {
        const kwBytes = _textToBytes(keyword);
        const txtBytes = _textToBytes(text);
        // data = keyword + null separator + text
        const dataLen = kwBytes.length + 1 + txtBytes.length;
        const data = new Uint8Array(dataLen);
        data.set(kwBytes, 0);
        data[kwBytes.length] = 0; // null separator
        data.set(txtBytes, kwBytes.length + 1);

        const typeBytes = _textToBytes("tEXt");

        // CRC covers type + data
        const crcInput = new Uint8Array(4 + dataLen);
        crcInput.set(typeBytes, 0);
        crcInput.set(data, 4);
        const crc = _crc32(crcInput);

        // Full chunk: length + type + data + crc
        const chunk = new Uint8Array(4 + 4 + dataLen + 4);
        chunk.set(_writeUint32(dataLen), 0);
        chunk.set(typeBytes, 4);
        chunk.set(data, 8);
        chunk.set(_writeUint32(crc), 8 + dataLen);
        return chunk;
    }

    /**
     * Build a PNG iTXt chunk for UTF-8 text.
     * keyword \0 compressionFlag(0) \0 compressionMethod(0) \0 languageTag \0 translatedKeyword \0 text
     */
    function _buildItxtChunk(keyword, text) {
        const kwBytes = _textToBytes(keyword);
        const txtBytes = new TextEncoder().encode(text); // UTF-8
        // data: kw + \0 + 0 + 0 + \0 + \0 + text
        const dataLen = kwBytes.length + 1 + 2 + 1 + 1 + txtBytes.length;
        const data = new Uint8Array(dataLen);
        let off = 0;
        data.set(kwBytes, off); off += kwBytes.length;
        data[off++] = 0; // null after keyword
        data[off++] = 0; // compression flag (none)
        data[off++] = 0; // compression method
        data[off++] = 0; // empty language tag, null terminated
        data[off++] = 0; // empty translated keyword, null terminated
        data.set(txtBytes, off);

        const typeBytes = _textToBytes("iTXt");
        const crcInput = new Uint8Array(4 + dataLen);
        crcInput.set(typeBytes, 0);
        crcInput.set(data, 4);
        const crc = _crc32(crcInput);

        const chunk = new Uint8Array(4 + 4 + dataLen + 4);
        chunk.set(_writeUint32(dataLen), 0);
        chunk.set(typeBytes, 4);
        chunk.set(data, 8);
        chunk.set(_writeUint32(crc), 8 + dataLen);
        return chunk;
    }

    // ════════════════════════════════════════════
    // INJECT CHUNKS INTO PNG
    // ════════════════════════════════════════════

    /**
     * Insert tEXt/iTXt chunks into raw PNG bytes, just before IDAT.
     * @param {Uint8Array} pngBytes - original PNG data
     * @param {Object} metadata - key/value pairs to embed
     * @returns {Uint8Array} new PNG with metadata
     */
    function _injectChunks(pngBytes, metadata) {
        // Find the first IDAT chunk offset
        let offset = 8; // skip signature
        let idatOffset = -1;
        while (offset < pngBytes.length - 8) {
            const len = _readUint32(pngBytes, offset);
            const type = _bytesToText(pngBytes.slice(offset + 4, offset + 8));
            if (type === "IDAT") {
                idatOffset = offset;
                break;
            }
            offset += 12 + len; // length(4) + type(4) + data(len) + crc(4)
        }

        if (idatOffset < 0) {
            console.warn("[PngMetadata] No IDAT found — returning original");
            return pngBytes;
        }

        // Build all metadata chunks
        const chunks = [];
        for (const [key, value] of Object.entries(metadata)) {
            if (!value) continue;
            // Use tEXt for ASCII-safe content, iTXt if it has non-Latin1 chars
            const needsUtf8 = /[^\x00-\xFF]/.test(value);
            chunks.push(needsUtf8 ? _buildItxtChunk(key, value) : _buildTextChunk(key, value));
        }

        if (!chunks.length) return pngBytes;

        // Total size of new chunks
        const extraLen = chunks.reduce((s, c) => s + c.length, 0);

        // Assemble: [signature + pre-IDAT chunks] + [metadata chunks] + [IDAT onward]
        const result = new Uint8Array(pngBytes.length + extraLen);
        result.set(pngBytes.slice(0, idatOffset), 0);
        let pos = idatOffset;
        for (const chunk of chunks) {
            result.set(chunk, pos);
            pos += chunk.length;
        }
        result.set(pngBytes.slice(idatOffset), pos);
        return result;
    }

    // ════════════════════════════════════════════
    // READ METADATA FROM PNG
    // ════════════════════════════════════════════

    /**
     * Parse all tEXt and iTXt chunks from a PNG file.
     * @param {File|Blob|ArrayBuffer} source
     * @returns {Promise<Object>} key/value pairs
     */
    async function read(source) {
        let buffer;
        if (source instanceof ArrayBuffer) {
            buffer = source;
        } else if (source instanceof Blob || source instanceof File) {
            buffer = await source.arrayBuffer();
        } else {
            return {};
        }

        const data = new Uint8Array(buffer);

        // Verify PNG signature
        for (let i = 0; i < 8; i++) {
            if (data[i] !== PNG_SIGNATURE[i]) return {};
        }

        const result = {};
        let offset = 8;
        while (offset < data.length - 8) {
            const len = _readUint32(data, offset);
            const typeBytes = data.slice(offset + 4, offset + 8);
            const type = _bytesToText(typeBytes);
            const chunkData = data.slice(offset + 8, offset + 8 + len);

            if (type === "tEXt") {
                // keyword \0 text (Latin-1)
                const nullIdx = chunkData.indexOf(0);
                if (nullIdx > 0) {
                    const key = _bytesToText(chunkData.slice(0, nullIdx));
                    const val = _bytesToText(chunkData.slice(nullIdx + 1));
                    result[key] = val;
                }
            } else if (type === "iTXt") {
                // keyword \0 compressionFlag compressionMethod languageTag\0 translatedKeyword\0 text
                const nullIdx = chunkData.indexOf(0);
                if (nullIdx > 0) {
                    const key = _bytesToText(chunkData.slice(0, nullIdx));
                    let off = nullIdx + 1;
                    const compressionFlag = chunkData[off++];
                    off++; // compression method
                    // language tag (null-terminated)
                    while (off < chunkData.length && chunkData[off] !== 0) off++;
                    off++; // skip null
                    // translated keyword (null-terminated)
                    while (off < chunkData.length && chunkData[off] !== 0) off++;
                    off++; // skip null
                    // text (UTF-8, possibly compressed)
                    const textBytes = chunkData.slice(off);
                    if (compressionFlag === 0) {
                        result[key] = new TextDecoder("utf-8").decode(textBytes);
                    }
                    // We don't handle zlib-compressed iTXt — rare in SD outputs
                }
            } else if (type === "IEND") {
                break;
            }

            offset += 12 + len;
        }

        return result;
    }

    // ════════════════════════════════════════════
    // EXPORT WITH METADATA
    // ════════════════════════════════════════════

    /**
     * Export a canvas element to a PNG Blob with embedded metadata.
     * @param {HTMLCanvasElement} canvas
     * @param {Object} metadata - key/value pairs (e.g. { parameters: "..." })
     * @returns {Promise<Blob>}
     */
    async function exportWithMetadata(canvas, metadata) {
        const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
        const buffer = await blob.arrayBuffer();
        const pngBytes = new Uint8Array(buffer);
        const injected = _injectChunks(pngBytes, metadata);
        return new Blob([injected], { type: "image/png" });
    }

    /**
     * Inject metadata into an existing PNG data URL.
     * @param {string} dataUrl - PNG data URL
     * @param {Object} metadata - key/value pairs
     * @returns {Promise<Blob>}
     */
    async function injectIntoDataUrl(dataUrl, metadata) {
        const resp = await fetch(dataUrl);
        const buffer = await resp.arrayBuffer();
        const injected = _injectChunks(new Uint8Array(buffer), metadata);
        return new Blob([injected], { type: "image/png" });
    }

    // ════════════════════════════════════════════
    // PARSE A1111 INFOTEXT
    // ════════════════════════════════════════════

    /**
     * Parse an A1111-format infotext string into structured fields.
     *
     * Format:
     *   prompt text here
     *   Negative prompt: negative text here
     *   Steps: 20, Sampler: DPM++ 2M SDE, Schedule type: Karras, CFG scale: 7, Seed: 12345, Size: 768x1024, Model: ponyDiffusionV6XL, ...
     *
     * @param {string} text
     * @returns {Object} parsed fields
     */
    function parseInfotext(text) {
        if (!text) return {};

        const result = {};
        const lines = text.split("\n");

        // Find the last line that starts with "Steps: " — that's the params line
        let paramsLineIdx = -1;
        for (let i = lines.length - 1; i >= 0; i--) {
            if (lines[i].startsWith("Steps: ") || lines[i].match(/^Steps:\s*\d/)) {
                paramsLineIdx = i;
                break;
            }
        }

        if (paramsLineIdx < 0) {
            // No structured params found — entire text is prompt
            result.prompt = text.trim();
            return result;
        }

        // Everything before the params line
        const preParams = lines.slice(0, paramsLineIdx).join("\n");

        // Split prompt and negative prompt
        const negMatch = preParams.match(/^([\s\S]*?)\nNegative prompt:\s*([\s\S]*)$/);
        if (negMatch) {
            result.prompt = negMatch[1].trim();
            result.negativePrompt = negMatch[2].trim();
        } else {
            result.prompt = preParams.trim();
        }

        // Parse the key: value pairs from the params line
        const paramsLine = lines.slice(paramsLineIdx).join(", ");
        // Match "Key: value" where value ends at the next ", Key:" or end of string
        // Keys are capitalized words possibly with spaces
        const paramRegex = /([A-Z][\w\s]*?):\s*((?:(?![A-Z][\w\s]*?:\s).)*)/g;
        let m;
        while ((m = paramRegex.exec(paramsLine)) !== null) {
            const key = m[1].trim();
            const val = m[2].trim().replace(/,\s*$/, "");
            const camel = key.charAt(0).toLowerCase() + key.slice(1).replace(/\s+(.)/g, (_, c) => c.toUpperCase());
            result[camel] = val;
        }

        // Convert numeric fields
        for (const k of ["steps", "seed", "cfgScale", "width", "height", "clipSkip", "ensd"]) {
            if (result[k] !== undefined) {
                const n = Number(result[k]);
                if (!isNaN(n)) result[k] = n;
            }
        }

        // Parse Size into width/height if present
        if (result.size && typeof result.size === "string") {
            const sm = result.size.match(/(\d+)\s*x\s*(\d+)/i);
            if (sm) {
                result.width = parseInt(sm[1]);
                result.height = parseInt(sm[2]);
            }
        }

        return result;
    }

    /**
     * Build an A1111-format infotext string from generation parameters.
     * @param {Object} params
     * @returns {string}
     */
    function buildInfotext(params) {
        const parts = [];

        // Prompt
        parts.push(params.prompt || "");

        // Negative prompt
        if (params.negativePrompt) {
            parts.push(`Negative prompt: ${params.negativePrompt}`);
        }

        // Parameter line
        const fields = [];
        if (params.steps != null) fields.push(`Steps: ${params.steps}`);
        if (params.sampler) fields.push(`Sampler: ${params.sampler}`);
        if (params.schedule) fields.push(`Schedule type: ${params.schedule}`);
        if (params.cfgScale != null) fields.push(`CFG scale: ${params.cfgScale}`);
        if (params.seed != null) fields.push(`Seed: ${params.seed}`);
        if (params.width && params.height) fields.push(`Size: ${params.width}x${params.height}`);
        if (params.model) fields.push(`Model: ${params.model}`);
        if (params.modelHash) fields.push(`Model hash: ${params.modelHash}`);
        if (params.clipSkip != null) fields.push(`Clip skip: ${params.clipSkip}`);

        // Hires
        if (params.hiresUpscaler) {
            fields.push(`Hires upscaler: ${params.hiresUpscaler}`);
            if (params.hiresSteps) fields.push(`Hires steps: ${params.hiresSteps}`);
            if (params.denoisingStrength != null) fields.push(`Denoising strength: ${params.denoisingStrength}`);
            if (params.hiresUpscale) fields.push(`Hires upscale: ${params.hiresUpscale}`);
        }

        if (fields.length) parts.push(fields.join(", "));

        return parts.join("\n");
    }

    // ════════════════════════════════════════════
    // PUBLIC API
    // ════════════════════════════════════════════

    return {
        read,
        exportWithMetadata,
        injectIntoDataUrl,
        parseInfotext,
        buildInfotext,
        // Expose for testing
        _buildTextChunk,
        _injectChunks,
    };

})();

console.log("[PngMetadata] Module loaded");
