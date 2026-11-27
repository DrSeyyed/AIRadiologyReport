import forms from '@tailwindcss/forms';
import typography from '@tailwindcss/typography';
import daisyui from 'daisyui';

export default {
	content: ['./src/**/*.{html,js,svelte,ts}'],
	darkMode: 'class',
	plugins: [forms, typography, daisyui],
	daisyui: {
		themes: ['light', 'dark'],
		// The theme is chosen by the user (or OS) via data-theme; see src/lib/theme.js.
		darkTheme: false
	}
};
