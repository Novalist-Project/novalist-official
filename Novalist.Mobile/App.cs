using Novalist.Mobile.Pages;

namespace Novalist.Mobile;

public class App : Application
{
    protected override Window CreateWindow(IActivationState? activationState)
    {
        var page = new RendererHostPage();
        var window = new Window(page) { Title = "Novalist" };
#if ANDROID
        window.Deactivated += (_, _) => (window.Page as RendererHostPage)?.SetBridgeForeground(false);
        window.Activated += (_, _) => (window.Page as RendererHostPage)?.SetBridgeForeground(true);
#endif
        window.Deactivated += (_, _) => (window.Page as RendererHostPage)?.RequestBackgroundSave();
        window.Stopped += (_, _) => (window.Page as RendererHostPage)?.RequestBackgroundSave();
        window.Destroying += (_, _) => (window.Page as RendererHostPage)?.Dispose();
        return window;
    }
}
