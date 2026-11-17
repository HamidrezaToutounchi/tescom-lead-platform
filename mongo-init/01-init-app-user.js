const dbName = process.env.MONGO_INITDB_DATABASE || 'tescom';
const appUser = process.env.MONGO_APP_USER;
const appPassword = process.env.MONGO_APP_PASSWORD;

if (!appUser || !appPassword) {
  throw new Error('MONGO_APP_USER and MONGO_APP_PASSWORD environment variables are required.');
}

const targetDb = db.getSiblingDB(dbName);

const existingUser = targetDb.getUser(appUser);
if (!existingUser) {
  targetDb.createUser({
    user: appUser,
    pwd: appPassword,
    roles: [{ role: 'readWrite', db: dbName }]
  });
  print(`[mongo-init] Created application user '${appUser}' with readWrite on '${dbName}'.`);
} else {
  print(`[mongo-init] Application user '${appUser}' already exists on '${dbName}'.`);
}

targetDb.createCollection('leads');
targetDb.leads.createIndex({ refCode: 1 }, { unique: true });
targetDb.leads.createIndex({ site: 1, createdAt: -1 });
targetDb.leads.createIndex({ brand: 1, createdAt: -1 });
targetDb.leads.createIndex({ createdAt: -1 });
targetDb.leads.createIndex({ email: 1 });
print(`[mongo-init] Initialized 'leads' collection and multi-site indexes on '${dbName}'.`);
