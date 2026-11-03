// Fills a NEW database with fictional sample data. Usage: DB_PATH=data/demo.db ADMIN_PASSWORD=admin npm run seed:demo
import { seedIfEmpty } from '../server/db.js';
import { seedDemo } from '../server/demo.js';
seedIfEmpty();
if (await seedDemo()) console.log('Sample data created. Sign in as admin, rania (team leader) or omar (member); member/leader password: demo');
else { console.log('Database already has people — aborting.'); process.exit(1); }
