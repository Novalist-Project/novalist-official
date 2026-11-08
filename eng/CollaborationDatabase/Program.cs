using Microsoft.EntityFrameworkCore;
using Novalist.Sync.Server.Data;

var connection = Environment.GetEnvironmentVariable("NOVALIST_COLLAB_TEST_DATABASE")
    ?? throw new InvalidOperationException("The manual test launcher must provide its local test database.");
var options = new DbContextOptionsBuilder<SyncDbContext>()
    .UseNpgsql(connection)
    .UseSnakeCaseNamingConvention();
await using var database = new SyncDbContext(options.Options);
await database.Database.MigrateAsync();
Console.WriteLine("Persistent test database ready.");
