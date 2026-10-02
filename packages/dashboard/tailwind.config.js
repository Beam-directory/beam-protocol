/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        accent: {
          DEFAULT: 'var(--accent)',
          foreground: 'var(--accent-foreground)',
          dim: '#c24802',
          glow: 'rgba(247,92,3,0.3)',
        },
        background: 'var(--background)',
        foreground: 'var(--foreground)',
        primary: {
          DEFAULT: 'var(--primary)',
          foreground: 'var(--primary-foreground)',
        },
        secondary: {
          DEFAULT: 'var(--secondary)',
          foreground: 'var(--secondary-foreground)',
        },
        muted: {
          DEFAULT: 'var(--muted)',
          foreground: 'var(--muted-foreground)',
        },
        destructive: 'var(--destructive)',
        card: {
          DEFAULT: 'var(--card)',
          foreground: 'var(--card-foreground)',
        },
        popover: {
          DEFAULT: 'var(--popover)',
          foreground: 'var(--popover-foreground)',
        },
        ring: 'var(--ring)',
        input: 'var(--input)',
        bg: {
          DEFAULT: '#0a0a0f',
          card: '#111118',
          code: '#0d0d14',
          hover: '#16161f',
        },
        border: {
          DEFAULT: 'var(--border)',
          glow: 'rgba(247,92,3,0.3)',
        },
        text: {
          DEFAULT: '#e8e8f0',
          muted: '#7070a0',
          dim: '#4a4a70',
        },
        signal: {
          green: '#39d98a',
          blue: '#4c9cf1',
          purple: '#b06ef3',
          red: '#f75c5c',
          yellow: '#f7c603',
        },
      },
      fontFamily: {
        mono: ['"JetBrains Mono"', '"Fira Code"', 'monospace'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      animation: {
        'pulse-slow': 'pulse 3s ease-in-out infinite',
        'fade-in': 'fadeIn 0.3s ease-out',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
    },
  },
  plugins: [],
}
