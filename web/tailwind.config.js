/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: { sans: ['Inter', 'ui-sans-serif', 'system-ui', 'Segoe UI', 'sans-serif'] },
      colors: {
        brand: { 50: '#eef2ff', 100: '#e0e7ff', 500: '#5b5bd6', 600: '#4b4bc2', 700: '#3d3da8' },
        ink: { 900: '#0f1222', 800: '#171a2e', 700: '#232743' },
      },
    },
  },
  plugins: [],
};
