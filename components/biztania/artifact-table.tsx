import type { ArtifactFact, ArtifactLabels } from '@/lib/visualization/contracts';
import { factLabel, factValue } from '@/lib/visualization/presentation';
import { operationLabel } from './product-labels';
import styles from './artifact-preview.module.css';

export function ArtifactTable({ facts, caption, labels }: { facts: readonly ArtifactFact[]; caption: string; labels?: ArtifactLabels }) {
  const thai = Boolean(labels);
  return <div className={styles.tableWrap} role="region" aria-label={caption} tabIndex={0}>
    <table className={styles.table}><caption>{caption}</caption><thead><tr>
      <th scope="col">{thai ? 'กลุ่มข้อมูล / ตัวชี้วัด' : 'Evidence group / measure'}</th><th scope="col">{thai ? 'ค่า' : 'Value'}</th>
      <th scope="col">{thai ? 'วิธีคำนวณ' : 'Calculation'}</th><th scope="col">{thai ? 'ที่มาและข้อควรระวัง' : 'Sources and caveats'}</th>
    </tr></thead><tbody>{facts.map(fact => <tr key={fact.claimId}>
      <th scope="row">{factLabel(fact, labels)}</th><td>{factValue(fact, labels)}</td><td>{thai ? operationLabel(fact.operation) : fact.operation}</td>
      <td>{fact.sourceRefs.join(', ')}{fact.caveat && <p>{fact.caveat}</p>}</td>
    </tr>)}</tbody></table>
  </div>;
}
