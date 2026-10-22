import { Link } from 'react-router-dom';

function GroupCard({ group }) {
  return (
    <div className="border border-slate-200 rounded-lg p-4 flex items-center justify-between">
      <div>
        <p className="font-medium text-slate-900">{group.name}</p>
        <p className="text-xs text-slate-500 mt-1">
          {group.memberCount} member{group.memberCount === 1 ? '' : 's'} ·{' '}
          <span className="uppercase">{group.myRole}</span> ·{' '}
          <span className={group.status === 'active' ? 'text-green-600' : 'text-slate-400'}>
            {group.status}
          </span>
        </p>
      </div>
      <Link
        to={`/groups/${group.id}`}
        className="text-sm font-medium text-slate-900 hover:underline whitespace-nowrap"
      >
        Open Group
      </Link>
    </div>
  );
}

export default GroupCard;
