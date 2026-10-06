// 台股產業分析的視窗外殼:用 Windows 內建的 WebView2 引擎顯示本機網頁,沒有網址列、分頁或 Edge 的介面。
// 以 Windows 內建的 csc.exe 編譯(C# 5,不需要安裝 SDK),見 scripts/build-shell.js。
// 參數:--url <網址> --title <視窗標題> --icon <ico 檔> --data <WebView2 暫存資料夾>
// 結束碼:0 正常關閉;2 缺少網址;3 WebView2 無法啟動(沒有安裝執行環境等),啟動器會改用 Edge 視窗。
using System;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

static class Program
{
    [DllImport("user32.dll")]
    static extern bool SetProcessDPIAware();

    [DllImport("dwmapi.dll")]
    static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int val, int size);

    // 標題列跟著畫面的主題:深色模式、標題列與邊框顏色、文字顏色(Windows 11 才有顏色設定,Windows 10 只有深淺模式)
    static void SetChrome(Form f, WebView2 wv, Color bg, bool dark)
    {
        try
        {
            int d = dark ? 1 : 0;
            DwmSetWindowAttribute(f.Handle, 20, ref d, 4);
            DwmSetWindowAttribute(f.Handle, 19, ref d, 4);
            int cap = bg.R | (bg.G << 8) | (bg.B << 16);
            DwmSetWindowAttribute(f.Handle, 35, ref cap, 4);
            DwmSetWindowAttribute(f.Handle, 34, ref cap, 4);
            Color t = dark ? Color.FromArgb(230, 237, 243) : Color.FromArgb(31, 35, 40);
            int txt = t.R | (t.G << 8) | (t.B << 16);
            DwmSetWindowAttribute(f.Handle, 36, ref txt, 4);
            f.BackColor = bg;
            wv.DefaultBackgroundColor = bg;
        }
        catch (Exception) { }
    }

    static bool IsLocal(string u)
    {
        Uri x;
        if (!Uri.TryCreate(u, UriKind.Absolute, out x)) return true;
        if (x.Scheme != "http" && x.Scheme != "https") return true; // about:blank 等
        return x.Host == "127.0.0.1" || x.Host == "localhost" || x.Host == "[::1]" || x.Host == "::1";
    }

    static void OpenExternal(string u)
    {
        try
        {
            Uri x = new Uri(u);
            if (x.Scheme == "http" || x.Scheme == "https")
            {
                ProcessStartInfo psi = new ProcessStartInfo(u);
                psi.UseShellExecute = true;
                Process.Start(psi);
            }
        }
        catch (Exception) { }
    }

    [STAThread]
    static int Main(string[] args)
    {
        string url = null, title = "台股產業分析", icon = null, data = null;
        for (int i = 0; i < args.Length; i++)
        {
            string a = args[i];
            if (a == "--url" && i + 1 < args.Length) url = args[++i];
            else if (a == "--title" && i + 1 < args.Length) title = args[++i];
            else if (a == "--icon" && i + 1 < args.Length) icon = args[++i];
            else if (a == "--data" && i + 1 < args.Length) data = args[++i];
        }
        if (url == null) return 2;

        try { SetProcessDPIAware(); } catch (Exception) { }
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        Color bg = Color.FromArgb(13, 17, 23);
        Form form = new Form();
        form.AutoScaleMode = AutoScaleMode.None; // 尺寸直接用實際像素,不要被 DPI 再放大一次
        form.Text = title;
        form.BackColor = bg;
        form.StartPosition = FormStartPosition.CenterScreen;
        Rectangle wa = Screen.PrimaryScreen.WorkingArea;
        form.Size = new Size((int)(wa.Width * 0.82), (int)(wa.Height * 0.9));
        form.MinimumSize = new Size(Math.Min(640, wa.Width), Math.Min(480, wa.Height));
        try { if (icon != null) form.Icon = new Icon(icon); } catch (Exception) { }

        WebView2 wv = new WebView2();
        wv.Dock = DockStyle.Fill;
        wv.DefaultBackgroundColor = bg;
        form.Controls.Add(wv);
        form.HandleCreated += (s, e) => SetChrome(form, wv, bg, true);

        int code = 0;
        form.Shown += async (s, e) =>
        {
            try
            {
                CoreWebView2Environment env = await CoreWebView2Environment.CreateAsync(null, data);
                await wv.EnsureCoreWebView2Async(env);
                CoreWebView2 core = wv.CoreWebView2;
                core.Settings.AreDevToolsEnabled = false;
                core.Settings.IsStatusBarEnabled = false;
                core.NewWindowRequested += (s2, e2) => { e2.Handled = true; OpenExternal(e2.Uri); };
                core.NavigationStarting += (s2, e2) => { if (!IsLocal(e2.Uri)) { e2.Cancel = true; OpenExternal(e2.Uri); } };
                core.DocumentTitleChanged += (s2, e2) => { if (!string.IsNullOrEmpty(core.DocumentTitle)) form.Text = core.DocumentTitle; };
                // 頁面會回報目前的背景色(r,g,b,是否深色),標題列跟著換
                core.WebMessageReceived += (s2, e2) =>
                {
                    try
                    {
                        string m = e2.TryGetWebMessageAsString();
                        string[] p = m.Split(',');
                        if (p.Length == 4) SetChrome(form, wv, Color.FromArgb(int.Parse(p[0]), int.Parse(p[1]), int.Parse(p[2])), p[3] == "1");
                    }
                    catch (Exception) { }
                };
                core.Navigate(url);
            }
            catch (Exception)
            {
                code = 3;
                form.Close();
            }
        };
        Application.Run(form);
        return code;
    }
}
