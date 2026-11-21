using System.Globalization;
using Novalist.Core.Services;
using Novalist.Core.Tests.TestHelpers;
using Xunit;

namespace Novalist.Core.Tests.Services;

public class ArabicInterfaceLanguageTests
{
    [Theory]
    [InlineData("ar-EG")]
    [InlineData("ar-SA")]
    public async Task FirstLaunchUsesArabicRegionalInterfaceLanguage(string culture)
    {
        using var directory = new TempDir();
        var previous = CultureInfo.CurrentUICulture;
        try
        {
            CultureInfo.CurrentUICulture = new CultureInfo(culture);
            var settings = new SettingsService(directory.Path);
            await settings.LoadAsync();

            Assert.Equal("ar", settings.Settings.Language);
            Assert.Equal("en", settings.Settings.AutoReplacementLanguage);
        }
        finally { CultureInfo.CurrentUICulture = previous; }
    }

    [Fact]
    public async Task ArabicOperatingSystemPreservesSavedInterfaceLanguage()
    {
        using var directory = new TempDir();
        var previous = CultureInfo.CurrentUICulture;
        try
        {
            CultureInfo.CurrentUICulture = new CultureInfo("ar-EG");
            var settings = new SettingsService(directory.Path);
            settings.Settings.Language = "de";
            await settings.SaveAsync();
            await settings.LoadAsync();

            Assert.Equal("de", settings.Settings.Language);
        }
        finally { CultureInfo.CurrentUICulture = previous; }
    }
}
