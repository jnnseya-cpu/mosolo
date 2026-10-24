import { Link } from 'react-router-dom';
import { Icon } from '../../components/Icon';
import { proofPrintUrl } from './shared';

/** Lien « Imprimer la preuve » (A6 ou ticket thermique, marquée Ville de Kinshasa, QR et code court vérifiables). */
export function PrintProofLink({ code, label = 'Imprimer' }: { code: string; label?: string }) {
  return (
    <Link className="btn btn-ghost btn-sm" to={proofPrintUrl(code)} aria-label={`${label} la preuve ${code}`}>
      <Icon name="download" size={14} /> {label}
    </Link>
  );
}
