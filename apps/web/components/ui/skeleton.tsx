import { cn } from '@/lib/cn';
import { Table, TableScroll, TBody, TD, TH, THead, TR } from './table';

/**
 * Loading states are skeletons of the real layout, never spinners.
 *
 * The row count and the column widths are passed in so the placeholder occupies
 * the same space the data will. A skeleton that is the wrong shape produces a
 * layout jump on arrival, which is worse than the spinner it replaced.
 */
export function Bar({ className }: { className?: string }) {
  return <div className={cn('skeleton h-3', className)} />;
}

export function TableSkeleton({
  columns,
  rows = 8,
}: {
  columns: { label: string; width: string; numeric?: boolean | undefined }[];
  rows?: number | undefined;
}) {
  return (
    <TableScroll>
      <Table>
        <colgroup>
          {columns.map((column) => (
            <col key={column.label} style={{ width: column.width }} />
          ))}
        </colgroup>
        <THead>
          <TR className="hover:bg-raised">
            {columns.map((column) => (
              <TH key={column.label} numeric={column.numeric}>
                {column.label}
              </TH>
            ))}
          </TR>
        </THead>
        <TBody>
          {Array.from({ length: rows }, (_, rowIndex) => (
            <TR key={rowIndex} className="hover:bg-surface">
              {columns.map((column) => (
                <TD key={column.label}>
                  <Bar className={column.numeric ? 'ml-auto w-12' : 'w-3/4'} />
                </TD>
              ))}
            </TR>
          ))}
        </TBody>
      </Table>
    </TableScroll>
  );
}
