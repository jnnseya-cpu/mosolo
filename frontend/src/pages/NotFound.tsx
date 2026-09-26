import { Link } from 'react-router-dom';
import { useApp } from '../context';
import { PageHead } from '../components/Shell';

export default function NotFound() {
  const { tr } = useApp();
  return (
    <div className="page">
      <PageHead eyebrow="404" title={tr('notFound.title')} lead={tr('notFound.body')} />
      <div className="btn-row">
        <Link className="btn btn-primary" to="/">{tr('nav.home')}</Link>
        <Link className="btn btn-secondary" to="/verifier">{tr('nav.verify')}</Link>
      </div>
    </div>
  );
}
