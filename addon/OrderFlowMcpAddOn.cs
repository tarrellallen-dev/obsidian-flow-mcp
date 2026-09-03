// ObsidianFlow Order-Flow MCP - AddOn entry point.
// Spec section 3.1: one AddOnBase subclass, one NTMenuItem "Order-Flow MCP" under the
// Control Center "New" menu, opening a small status window.
// .NET Framework 4.8. ASCII only.

using System;
using System.Windows;
using NinjaTrader.Gui;
using NinjaTrader.Gui.Tools;

namespace NinjaTrader.NinjaScript.AddOns.ObsidianFlowOrderFlowMcp
{
    public class OrderFlowMcpAddOn : NinjaTrader.NinjaScript.AddOnBase
    {
        private NTMenuItem _menuItem;
        private NTMenuItem _controlCenterNewMenu;

        protected override void OnStateChange()
        {
            if (State == State.SetDefaults)
            {
                Name = "ObsidianFlow Order-Flow MCP";
                Description = "Publishes NinjaTrader market data over a named pipe for the Order-Flow MCP server.";
            }
            else if (State == State.Configure)
            {
                // Engine.Start is idempotent; NinjaScript may construct this type more than once.
                try
                {
                    Engine.Instance.Start();
                }
                catch (Exception ex)
                {
                    NinjaTrader.Code.Output.Process(
                        "ObsidianFlow Order-Flow MCP: start failed: " + ex.Message,
                        PrintTo.OutputTab1);
                }
            }
            else if (State == State.Terminated)
            {
                try
                {
                    Engine.Instance.Stop();
                }
                catch (Exception)
                {
                }
            }
        }

        protected override void OnWindowCreated(Window window)
        {
            ControlCenter controlCenter = window as ControlCenter;
            if (controlCenter == null)
                return;

            _controlCenterNewMenu = controlCenter.FindFirst("ControlCenterMenuItemNew") as NTMenuItem;
            if (_controlCenterNewMenu == null)
                return;

            _menuItem = new NTMenuItem();
            _menuItem.Header = "Order-Flow MCP";
            _menuItem.Style = Application.Current.TryFindResource("MainMenuItem") as Style;
            _menuItem.Click += OnMenuItemClick;

            _controlCenterNewMenu.Items.Add(_menuItem);
        }

        protected override void OnWindowDestroyed(Window window)
        {
            if (_menuItem == null || !(window is ControlCenter))
                return;

            if (_controlCenterNewMenu != null && _controlCenterNewMenu.Items.Contains(_menuItem))
                _controlCenterNewMenu.Items.Remove(_menuItem);

            _menuItem.Click -= OnMenuItemClick;
            _menuItem = null;
            _controlCenterNewMenu = null;
        }

        private void OnMenuItemClick(object sender, RoutedEventArgs e)
        {
            // Already on the UI thread here (WPF click handler).
            try
            {
                StatusWindow w = new StatusWindow();
                w.Show();
            }
            catch (Exception ex)
            {
                NinjaTrader.Code.Output.Process(
                    "ObsidianFlow Order-Flow MCP: status window failed: " + ex.Message,
                    PrintTo.OutputTab1);
            }
        }
    }
}
