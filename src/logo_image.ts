/**
 * Generates a simple bitmap for the G2 display.
 * The G2 uses a 1-bit or 4-bit grayscale format.
 * For simplicity, we'll create a raw byte buffer representing a centered text logo.
 *
 * Note: Real image generation would require a canvas or advanced BMP library.
 * Here we construct a minimal valid 1-bit pixel array for "G2 READER".
 */

export const LOGO_WIDTH = 640;
export const LOGO_HEIGHT = 350;

// Simple 5x7 font map
const FONT: Record<string, number[]> = {
    'G': [0x1E, 0x20, 0x20, 0x2E, 0x22, 0x22, 0x1E],
    '2': [0x1C, 0x22, 0x02, 0x0C, 0x10, 0x20, 0x3E],
    'R': [0x3C, 0x22, 0x22, 0x3C, 0x28, 0x24, 0x22],
    'E': [0x3E, 0x20, 0x20, 0x3C, 0x20, 0x20, 0x3E],
    'A': [0x1C, 0x22, 0x22, 0x3E, 0x22, 0x22, 0x22],
    'D': [0x3C, 0x22, 0x22, 0x22, 0x22, 0x22, 0x3C],
    'P': [0x3C, 0x22, 0x22, 0x3C, 0x20, 0x20, 0x20],
    'e': [0x00, 0x00, 0x1C, 0x22, 0x3E, 0x20, 0x1E], // Small e
    'u': [0x00, 0x00, 0x22, 0x22, 0x22, 0x22, 0x1E], // Small u
    'b': [0x20, 0x20, 0x3C, 0x22, 0x22, 0x22, 0x3C], // Small b
    'a': [0x00, 0x00, 0x1C, 0x02, 0x1E, 0x22, 0x1E], // Small a
    'd': [0x02, 0x02, 0x1E, 0x22, 0x22, 0x22, 0x1E], // Small d
    'r': [0x00, 0x00, 0x2C, 0x32, 0x20, 0x20, 0x20], // Small r
    ' ': [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
};

// Helper to draw a character into the buffer
function drawChar(buffer: Uint8Array, char: string, xOffset: number, yOffset: number, scale: number) {
    const pattern = FONT[char] || FONT[' '];
    for (let y = 0; y < 7; y++) {
        const row = pattern[y];
        for (let x = 0; x < 5; x++) {
            if ((row >> (5 - x)) & 1) { // Fixed off-by-one
                // Draw pixel scaled
                for (let dy = 0; dy < scale; dy++) {
                    for (let dx = 0; dx < scale; dx++) {
                        const px = xOffset + x * scale + dx;
                        const py = yOffset + y * scale + dy;
                        if (px < LOGO_WIDTH && py < LOGO_HEIGHT) {
                            buffer[py * LOGO_WIDTH + px] = 255;
                        }
                    }
                }
            }
        }
    }
}

// Helper to draw a pixel
function drawPixel(buffer: Uint8Array, x: number, y: number) {
    // Floor coordinates to handle sub-pixel logic (e.g. scale 1.5)
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    if (ix >= 0 && ix < LOGO_WIDTH && iy >= 0 && iy < LOGO_HEIGHT) {
        buffer[iy * LOGO_WIDTH + ix] = 255;
    }
}

// Helper to draw a scaled pixel (block)
function drawBlock(buffer: Uint8Array, x: number, y: number, scale: number) {
    for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
            drawPixel(buffer, x + dx, y + dy);
        }
    }
}

// Helper to draw a vertical line
function drawVLine(buffer: Uint8Array, x: number, y: number, length: number, scale: number) {
    for (let i = 0; i < length; i++) {
        drawBlock(buffer, x, y + i * scale, scale);
    }
}

// Helper to draw a horizontal line
function drawHLine(buffer: Uint8Array, x: number, y: number, length: number, scale: number) {
    for (let i = 0; i < length; i++) {
        drawBlock(buffer, x + i * scale, y, scale);
    }
}

// Draw a diagonal line (simple Bresenham-like or step)
function drawLine(buffer: Uint8Array, x0: number, y0: number, x1: number, y1: number, scale: number) {
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = (x0 < x1) ? 1 : -1;
    const sy = (y0 < y1) ? 1 : -1;
    let err = dx - dy;

    while (true) {
        drawBlock(buffer, x0 * scale, y0 * scale, scale); // Scale only at drawing time? 
        // Logic units are passed in, so we multiply by scale here?
        // Wait, drawBlock expects coordinates in pixels? 
        // Previous usages: drawVLine(buffer, startX, startY, height, scale)
        // startX was pixel coordinate. height was logic units?
        // Let's check previous drawTallBook usage:
        // drawVLine(buffer, startX, startY, height, scale);
        // -> drawBlock(buffer, x, y + i * scale, scale);
        // So x, y are pixels. i is logic step.
        // So this drawLine helper should comfortably work in pixels if we pass pixels, 
        // OR work in logic units if we pass logic units.
        // Ideally we pass logic units and scale inside.
        // BUT drawBlock takes (x,y) as pixels.
        // Let's rewrite drawLine to take PIXEL coords for simplicity in this context, 
        // or logic coords and scale.

        if ((x0 === x1) && (y0 === y1)) break;
        const e2 = 2 * err;
        if (e2 > -dy) { err -= dy; x0 += sx; }
        if (e2 < dx) { err += dx; y0 += sy; }
    }
}

// Better drawLine for logic units
function drawLogicLine(buffer: Uint8Array, Lx0: number, Ly0: number, Lx1: number, Ly1: number, startX: number, startY: number, scale: number) {
    // Bresenham on logic grid
    let x0 = Math.floor(Lx0);
    let y0 = Math.floor(Ly0);
    const x1 = Math.floor(Lx1);
    const y1 = Math.floor(Ly1);

    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = (x0 < x1) ? 1 : -1;
    const sy = (y0 < y1) ? 1 : -1;
    let err = dx - dy;

    while (true) {
        drawBlock(buffer, startX + x0 * scale, startY + y0 * scale, scale);

        if ((x0 === x1) && (y0 === y1)) break;
        const e2 = 2 * err;
        if (e2 > -dy) { err -= dy; x0 += sx; }
        if (e2 < dx) { err += dx; y0 += sy; }
    }
}

// Draw the Book with Download Icon procedurally
function drawBookDownloadIcon(buffer: Uint8Array, startX: number, startY: number, height: number, width: number, scale: number) {
    // 1. Outline (Rounded Rect Book)
    const spineWidth = 6;
    // We'll draw 3-4 "leaves"

    // Page 1 (Front/Rightmost)
    const p1Open = 30; // Width of page area
    const p1TopY = 4;
    const p1BotY = height - 5;

    // Top edge of page block
    drawLogicLine(buffer, spineWidth, 1, spineWidth + p1Open, p1TopY, startX, startY, scale);
    // Bottom edge of page block
    drawLogicLine(buffer, spineWidth, height - 1, spineWidth + p1Open, p1BotY, startX, startY, scale);
    // Right edge
    drawLogicLine(buffer, spineWidth + p1Open, p1TopY, spineWidth + p1Open, p1BotY, startX, startY, scale);

    // Page 2 (Middle)
    // drawLogicLine(buffer, spineWidth, 1, spineWidth + p1Open - 5, p1TopY + 2, startX, startY, scale);
    // drawLogicLine(buffer, spineWidth + p1Open - 5, p1TopY + 2, spineWidth + p1Open - 5, p1BotY - 2, startX, startY, scale);

    // Detailed Lines (Text hint?)
    // Horizontal lines on the page
    const pageX = startX + (spineWidth + 4) * scale;
    const pageW = (p1Open - 8);
    for (let i = 0; i < 5; i++) {
        const ly = 15 + i * 10;
        if (ly < height - 10) {
            drawHLine(buffer, pageX, startY + ly * scale, pageW, scale);
        }
    }

    // 3. Page Curve / Spine Shadow
    // Vertical line inside spine for depth
    drawVLine(buffer, startX + 2 * scale, startY + 2 * scale, height - 4, scale);
}

export function generateLogoBuffer(): number[] {
    const buffer = new Uint8Array(LOGO_WIDTH * LOGO_HEIGHT).fill(0);

    const text = "G2 ePub Reader";
    const textScale = 6;
    const textHeight = 7 * textScale;
    const textWidth = text.length * 6 * textScale;

    // Center Text Vertically and Horizontally
    const startY = Math.floor((LOGO_HEIGHT - textHeight) / 2);
    const textX = Math.floor((LOGO_WIDTH - textWidth) / 2);

    // Draw Text
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (FONT[char]) {
            drawChar(buffer, char, textX + i * 6 * textScale, startY, textScale);
        }
    }

    return Array.from(buffer);
}
