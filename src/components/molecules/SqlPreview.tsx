/** Colour-coded list of statements (used by the apply-changes dialog). */
export default function SqlPreview({ statements }: { statements: string[] }) {
  return (
    <div className="sql-preview">
      {statements.map((s, i) => {
        const cls = s.startsWith("DELETE") ? "del" : s.startsWith("INSERT") ? "ins" : s.startsWith("UPDATE") ? "upd" : "";
        return (
          <div key={i} className={cls}>
            {s};
          </div>
        );
      })}
    </div>
  );
}
