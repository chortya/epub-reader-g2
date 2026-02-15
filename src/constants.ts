// Even G2 Display Specifications
// SDK PROPERTY CONSTRAINTS (from official documentation):
// - xPosition range: 0-576
// - yPosition range: 0-288
// - TextContainer: width max 576, height max 288
// - ImageContainer: width max 200, height max 100
// - containerName max: 16 characters
// - **IMAGES FORBIDDEN IN STARTUP PHASE** (createStartUpPageContainer)
// - Images ONLY work in rebuildPageContainer (post-startup pages)
export const DISPLAY_WIDTH = 576;  // SDK maximum X range
export const DISPLAY_HEIGHT = 288; // SDK maximum Y range

// Characters per line for word-wrapping
// Updated to 60 to prevent overflows in some EPUBs
export const CHARS_PER_LINE = 60;

// Lines per page (9 lines to fit with progress bar in 288px)
export const LINES_PER_PAGE = 9;

export const SWIPE_COOLDOWN_MS = 300;

export const STORAGE_KEY_POSITION = 'epub-reading-position';
export const STORAGE_KEY_BOOK_TITLE = 'epub-book-title';
