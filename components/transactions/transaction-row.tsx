import { formatToman, formatJalaaliDateShort } from "@/lib/format";

interface TransactionRowProps {
  description: string | null;
  rawInput: string;
  date: Date;
  amount: number;
  type: string;
  category: { name: string; icon: string; color: string };
}

export function TransactionRow({ description, rawInput, date, amount, type, category }: TransactionRowProps) {
  const isIncome = type === "income";
  return (
    <div className="flex items-center gap-3 py-3">
      <div
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-lg"
        style={{ backgroundColor: `${category.color}1f` }}
      >
        {category.icon}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">{description || rawInput}</p>
        <p className="text-xs text-muted">
          {category.name} · {formatJalaaliDateShort(date)}
        </p>
      </div>
      <p className={`shrink-0 text-sm font-semibold tabular-fa ${isIncome ? "text-success" : "text-warning"}`}>
        {isIncome ? "+" : "−"} {formatToman(amount)}
      </p>
    </div>
  );
}
