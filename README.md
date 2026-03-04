# EduEnroll — Nihon Moment

**Nihon Moment — Japanese Language School Enrollment System**

Built in Myanmar, supports MMK currency and Myanmar + English bilingual interface.

## Tech Stack

- **Framework**: Next.js 14 (App Router)
- **Language**: TypeScript
- **Styling**: Tailwind CSS
- **Fonts**: Noto Sans + Noto Sans Myanmar (Google Fonts)
- **Database**: Supabase (PostgreSQL)
- **Linting**: ESLint + Prettier

## Project Structure

```
src/
├── app/
│   ├── (admin)/          # Admin dashboard routes (protected)
│   ├── (public)/
│   │   └── enroll/       # Public enrollment flow
│   └── layout.tsx        # Root layout with Myanmar font support
├── components/
│   ├── ui/               # Shared UI primitives
│   ├── admin/            # Admin-specific components
│   └── enrollment/       # Enrollment form components
├── lib/                  # Utilities, Supabase client, helpers
└── types/                # Shared TypeScript types
supabase/
└── migrations/           # SQL migration files
```

## Getting Started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Scripts

| Command          | Description                  |
| ---------------- | ---------------------------- |
| `npm run dev`    | Start development server     |
| `npm run build`  | Build for production         |
| `npm run lint`   | Run ESLint                   |
| `npm run format` | Format code with Prettier    |

## Localization

The interface supports both **Myanmar (မြန်မာဘာသာ)** and **English**. Prices are displayed in **MMK (Myanmar Kyat)**.
