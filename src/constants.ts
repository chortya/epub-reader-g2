export const DISPLAY_WIDTH = 640;
export const DISPLAY_HEIGHT = 350;

// Characters per line for word-wrapping
// Updated to 55 to safely fit 18px font in 640px width (avoiding edge truncation)
export const CHARS_PER_LINE = 55;

// Lines per page (fits ~330px text area without scrolling)
// Verified 10 lines is safe for real hardware (15 caused scrolling)
export const LINES_PER_PAGE = 10;

export const SWIPE_COOLDOWN_MS = 300;

export const STORAGE_KEY_POSITION = 'epub-reading-position';
export const STORAGE_KEY_BOOK_TITLE = 'epub-book-title';
