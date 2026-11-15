// Extends Vitest's `expect` with DOM matchers (toBeInTheDocument, toHaveAttribute, ...).
// Use the /vitest entrypoint so it registers against Vitest's expect without global injection.
import '@testing-library/jest-dom/vitest';
