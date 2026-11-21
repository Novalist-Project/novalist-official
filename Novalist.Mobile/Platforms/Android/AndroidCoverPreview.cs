using Android.Graphics;
using Uri = Android.Net.Uri;

namespace Novalist.Mobile.Services;

internal static class AndroidCoverPreview
{
    internal static string? Read(DocumentTreeEntry entry)
    {
        var resolver = Platform.AppContext.ContentResolver ?? throw new IOException("No document provider is available.");
        using var uri = Uri.Parse(entry.Id) ?? throw new IOException("The provider returned an invalid cover URI.");
        try
        {
            var format = Bitmap.CompressFormat.WebpLossy ?? throw new IOException("The Android WebP encoder is unavailable.");
            using var source = ImageDecoder.CreateSource(resolver, uri);
            using var sizing = new ShelfSize();
            using var bitmap = ImageDecoder.DecodeBitmap(source, sizing);
            using var output = new MemoryStream();
            return bitmap.Compress(format, 80, output)
                ? $"data:image/webp;base64,{Convert.ToBase64String(output.GetBuffer(), 0, (int)output.Length)}"
                : null;
        }
        catch (Java.IO.IOException error) { throw new IOException("The cover could not be decoded.", error); }
        catch (Java.Lang.SecurityException error) { throw new UnauthorizedAccessException("Access to the cover was revoked.", error); }
    }

    private sealed class ShelfSize : Java.Lang.Object, ImageDecoder.IOnHeaderDecodedListener
    {
        public void OnHeaderDecoded(ImageDecoder decoder, ImageDecoder.ImageInfo info, ImageDecoder.Source source)
        {
            using var size = info.Size;
            const int longestEdge = 480;
            double scale = Math.Min(1d, (double)longestEdge / Math.Max(size.Width, size.Height));
            decoder.Allocator = ImageDecoderAllocator.Software;
            decoder.SetTargetSize(Math.Max(1, (int)Math.Round(size.Width * scale)),
                Math.Max(1, (int)Math.Round(size.Height * scale)));
        }
    }
}
