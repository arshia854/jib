// One-off backfill for users who onboarded before DefaultCategory was
// seeded (see prisma/seed.ts): their Category table ended up empty since
// seedDefaultsForUser copied from an empty DefaultCategory table at the
// time. Finds any user with zero Category rows and runs the same copy
// logic (lib/data/onboarding.ts's seedDefaultCategoriesForUser) for them.
import "dotenv/config";
import { prisma } from "@/lib/prisma";
import { seedDefaultCategoriesForUser } from "@/lib/data/onboarding";

async function main() {
  const users = await prisma.user.findMany({ select: { id: true, email: true, phoneNumber: true } });

  const usersToBackfill = [];
  for (const user of users) {
    const categoryCount = await prisma.category.count({ where: { userId: user.id } });
    if (categoryCount === 0) {
      usersToBackfill.push(user);
    }
  }

  for (const user of usersToBackfill) {
    await seedDefaultCategoriesForUser(user.id);
  }

  console.log(`Backfilled ${usersToBackfill.length} of ${users.length} user(s).`);
  for (const user of usersToBackfill) {
    const categoryCount = await prisma.category.count({ where: { userId: user.id } });
    console.log(`  user ${user.id} (${user.email ?? user.phoneNumber}): ${categoryCount} categories`);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
