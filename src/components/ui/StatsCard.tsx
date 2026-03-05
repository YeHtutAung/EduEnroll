interface StatsCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  colorAccent?: string;
}

export default function StatsCard({
  title,
  value,
  subtitle,
  colorAccent = "#1a3f8a",
}: StatsCardProps) {
  return (
    <div
      className="relative bg-white rounded-xl shadow-sm border border-gray-100 px-5 py-4 overflow-hidden"
      style={{ borderLeft: `4px solid ${colorAccent}` }}
    >
      <p className="text-xs font-semibold uppercase tracking-wider text-gray-500">{title}</p>
      <p
        className="mt-1 text-3xl font-bold tracking-tight"
        style={{ color: colorAccent }}
      >
        {value}
      </p>
      {subtitle && (
        <p className="mt-0.5 text-sm text-gray-400">{subtitle}</p>
      )}
    </div>
  );
}
