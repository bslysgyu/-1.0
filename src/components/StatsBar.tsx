import React from 'react';
import { CalendarDays, CalendarRange, LibraryBig } from 'lucide-react';
import type { ReadingStats } from '../types/bookshelf';
import { formatPercent } from '../utils/dateStats';

interface StatsBarProps {
  stats: ReadingStats;
}

export const StatsBar: React.FC<StatsBarProps> = ({ stats }) => {
  const cards = [
    {
      key: 'week',
      label: '本周阅读量',
      value: formatPercent(stats.weekTotal),
      desc: `本周累计推进 · 涉及 ${stats.weekBookCount} 本书`,
      icon: CalendarDays,
      iconClass: 'bg-[#e6efe8] text-[#3a5742]',
    },
    {
      key: 'month',
      label: '本月阅读量',
      value: formatPercent(stats.monthTotal),
      desc: `本月累计推进 · 涉及 ${stats.monthBookCount} 本书`,
      icon: CalendarRange,
      iconClass: 'bg-[#f4eadc] text-[#7c5630]',
    },
    {
      key: 'year',
      label: '本年度阅读量',
      value: formatPercent(stats.yearTotal),
      desc: `本年累计推进 · 涉及 ${stats.yearBookCount} 本书`,
      icon: LibraryBig,
      iconClass: 'bg-[#eae8e2] text-[#4c4238]',
    },
  ];

  return (
    <section
      aria-label="阅读量统计"
      className="grid grid-cols-1 md:grid-cols-3 gap-3.5 mb-5"
    >
      {cards.map((card) => {
        const Icon = card.icon;
        return (
          <div
            key={card.key}
            className="bg-[#fbf7ef] border border-[#d6c8b4] rounded-xl px-4 py-3.5 flex items-center justify-between gap-3 shadow-[0_2px_8px_rgba(45,30,16,0.06)]"
          >
            <div className="min-w-0">
              <div className="text-[12.5px] font-medium text-[#6b5d4f] mb-1">
                {card.label}
              </div>
              <div className="text-[26px] font-bold text-[#261e17] leading-tight tracking-tight tabular-nums">
                {card.value}
              </div>
              <div className="text-[11.5px] text-[#857564] mt-1 truncate tabular-nums">
                {card.desc}
              </div>
            </div>
            <div
              className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${card.iconClass}`}
              aria-hidden="true"
            >
              <Icon className="w-5 h-5" />
            </div>
          </div>
        );
      })}
    </section>
  );
};
